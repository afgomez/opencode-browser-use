import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { once } from "node:events"
import { mkdtemp, mkdir, readFile, rm, utimes } from "node:fs/promises"
import { createServer } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { BrowserManager } from "../src/manager"
import { Chrome, type BrowserProcess } from "../src/chrome"
import { Cdp } from "../src/cdp"
import { loadCatalog } from "../src/mcp"
import { options } from "../src/options"
import { wrappedCatalog } from "../src/policy"
import { emptySnapshot } from "../src/rpc"

test("real Chrome + private MCP: concurrency, scope, screenshots, cookies, restarts, locks, cleanup", { timeout: 180_000 }, async () => {
  const base = join(tmpdir(), "opencode")
  await mkdir(base, { recursive: true })
  const directory = await mkdtemp(join(base, "browser-use-test-"))
  const config = options({ profileDirectory: join(directory, "profile") })
  const chrome = new Chrome(config)
  // Exercise mode switching and the complete login protocol without opening a window or stealing
  // focus during automated tests. Actual headed UI is a separate manual check.
  const requestedModes: boolean[] = []
  let browser!: BrowserProcess
  const manager = new BrowserManager(config, { chrome: {
    start: async (headless) => { requestedModes.push(headless); return browser = await chrome.start(true) }, stop: (release) => chrome.stop(release),
  } })
  const server = createServer((request, response) => {
    if (request.url === "/set-cookie") response.setHeader("Set-Cookie", "browser_use_test=authenticated; Max-Age=3600; Path=/; SameSite=Lax")
    response.setHeader("Content-Type", "text/html")
    response.end(`<title>${request.url}</title><h1>${request.url}</h1><label>Name<input name="name"></label><button onclick="document.querySelector('h1').textContent='Clicked'">Click me</button>`)
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address() as { port: number }
  const origin = `http://127.0.0.1:${address.port}`
  const a = { sessionID: "integration-a", directory }
  const b = { sessionID: "integration-b", directory }
  const parse = (result: any) => JSON.parse(typeof result.content === "string" ? result.content : result.content[0].text)
  try {
    assert.deepEqual(await manager.inspectPages(a.sessionID), emptySnapshot())
    assert.deepEqual(requestedModes, [])
    const catalog = wrappedCatalog(await loadCatalog(config.nodePath))
    assert.ok(catalog.some((tool) => tool.name === "take_snapshot"))
    assert.equal(catalog.length, 21)
    const [openedA, openedB] = await Promise.all([
      manager.execute("new_page", { url: `${origin}/set-cookie` }, a),
      manager.execute("new_page", { url: `${origin}/b-private` }, b),
    ])
    const pageA = parse(openedA).pages[0].pageId
    const pageB = parse(openedB).pages[0].pageId
    assert.equal(typeof pageA, "string")
    assert.ok(!JSON.stringify(openedA).includes("b-private"))
    assert.deepEqual(await manager.inspectPages(a.sessionID), {
      ...emptySnapshot(),
      pages: [{ pageId: pageA, title: "/set-cookie", url: `${origin}/set-cookie` }],
    })
    assert.deepEqual(await manager.inspectPages("unowned-session"), emptySnapshot())
    browser.cdp.close()
    assert.equal(Cdp.disconnected(browser.cdp), true)
    assert.deepEqual(await manager.inspectPages(a.sessionID), {
      ...emptySnapshot(), pages: [{ pageId: pageA, title: "/set-cookie", url: `${origin}/set-cookie` }],
    })
    assert.equal(Cdp.disconnected(browser.cdp), false)
    assert.deepEqual(requestedModes, [true], "repairing metadata must not restart Chrome")
    assert.equal((await manager.inspectPages(b.sessionID)).pages[0].pageId, pageB)
    await assert.rejects(manager.execute("take_snapshot", { pageId: pageA }, b), /foreign page handle/)
    const snapshot = await manager.execute("take_snapshot", { pageId: pageA }, a)
    assert.match(JSON.stringify(snapshot), /set-cookie/)
    assert.ok(!JSON.stringify(snapshot).includes("b-private"))
    // The restored URL must NOT set the cookie again, or this would not test persistence.
    await manager.execute("navigate_page", { pageId: pageA, url: `${origin}/after-login` }, a)
    const screenshot = await manager.execute("take_screenshot", { pageId: pageA, format: "jpeg" }, a)
    assert.ok(Array.isArray(screenshot.content) && screenshot.content.some((item) => item.type === "file" && item.mime === "image/jpeg"))
    const competitor = new Chrome(config)
    await assert.rejects(competitor.start(true), /another OpenCode service/)
    const headed = parse(await manager.execute("switch_mode", { mode: "headed" }, a))
    assert.equal(headed.mode, "headed")
    assert.equal(headed.paused, false)
    assert.deepEqual(headed.pages.map((page: any) => page.pageId), [pageA])
    assert.equal(parse(await manager.execute("status", {}, b)).mode, "headed")
    const visibleSnapshot = await manager.execute("take_snapshot", { pageId: pageB }, b)
    assert.match(JSON.stringify(visibleSnapshot), /b-private/)
    const beforeNoop = requestedModes.length
    assert.equal(parse(await manager.execute("switch_mode", { mode: "headed" }, a)).changed, false)
    assert.equal(requestedModes.length, beforeNoop)
    await manager.execute("switch_mode", { mode: "headless" }, b)
    assert.deepEqual(requestedModes, [true, false, true])
    assert.equal(parse(await manager.execute("list_pages", {}, a)).pages[0].pageId, pageA)
    await manager.execute("login_start", { pageId: pageA }, a)
    assert.equal((await manager.inspectPages(a.sessionID)).pages[0].pageId, pageA)
    assert.equal(parse(await manager.execute("status", {}, a)).paused, true)
    await assert.rejects(manager.execute("take_snapshot", { pageId: pageB }, b), /paused/)
    await assert.rejects(manager.execute("switch_mode", { mode: "headless" }, b), /paused for human login/)
    await manager.execute("login_finish", {}, a)
    const cookies = await manager.execute("evaluate_script", { pageId: pageA, function: "() => document.cookie" }, a)
    assert.match(JSON.stringify(cookies), /browser_use_test=authenticated/)
    const listedB = parse(await manager.execute("list_pages", {}, b))
    assert.equal(listedB.pages[0].pageId, pageB)
    assert.equal(listedB.pages[0].url, `${origin}/b-private`)
    await manager.execute("release", {}, a)
    assert.deepEqual(await manager.inspectPages(a.sessionID), emptySnapshot())
    assert.equal(parse(await manager.execute("status", {}, b)).running, true)
    assert.equal(parse(await manager.execute("list_pages", {}, b)).pages.length, 1)
    await manager.execute("close_page", { pageId: pageB }, b)
    assert.deepEqual(await manager.inspectPages(b.sessionID), emptySnapshot())
    assert.equal(parse(await manager.execute("list_pages", {}, b)).pages.length, 0)
  } finally {
    await manager.dispose()
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
    await rm(directory, { recursive: true, force: true })
  }
})

test("a crashed manager's Chrome is verified and reclaimed after the profile lock becomes stale", { timeout: 60_000 }, async () => {
  const base = join(tmpdir(), "opencode")
  await mkdir(base, { recursive: true })
  const directory = await mkdtemp(join(base, "browser-use-recovery-test-"))
  const profileDirectory = join(directory, "profile")
  const script = `
    import { Chrome } from './src/chrome.ts';
    import { options } from './src/options.ts';
    const chrome = new Chrome(options({profileDirectory: ${JSON.stringify(profileDirectory)}}));
    await chrome.start(true);
    console.log('READY');
    setInterval(() => {}, 1000);
  `
  const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], { stdio: ["ignore", "pipe", "pipe"] })
  const chrome = new Chrome(options({ profileDirectory }))
  try {
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Recovery fixture startup timed out")), 30_000)
      let output = ""
      child.stdout.on("data", (chunk) => {
        output += String(chunk)
        if (output.includes("READY")) { clearTimeout(timeout); resolve() }
      })
      child.stderr.on("data", () => {})
      child.on("error", (error) => { clearTimeout(timeout); reject(error) })
      child.on("exit", () => { clearTimeout(timeout); reject(new Error("Recovery fixture exited before ready")) })
    })
    const original = JSON.parse(await readFile(join(profileDirectory, ".opencode-browser-use.json"), "utf8"))
    const exited = once(child, "exit")
    child.kill("SIGKILL")
    await exited
    // Model the documented 30-second stale-lock interval without delaying the test.
    const past = new Date(Date.now() - 120_000)
    await utimes(join(profileDirectory, ".opencode-browser-use.lock"), past, past)
    const recovered = await chrome.start(true)
    assert.ok(recovered.alive())
    const current = JSON.parse(await readFile(join(profileDirectory, ".opencode-browser-use.json"), "utf8"))
    assert.notEqual(current.pid, original.pid)
    await assert.rejects(Cdp.connect(original.endpoint))
  } finally {
    child.kill("SIGKILL")
    await chrome.stop()
    // If recovery itself failed, also clean up our exact advertised test browser.
    try {
      const saved = JSON.parse(await readFile(join(profileDirectory, ".opencode-browser-use.json"), "utf8"))
      const cdp = await Cdp.connect(saved.endpoint)
      await cdp.send("Browser.close").catch(() => {})
      cdp.close()
    } catch {}
    await rm(directory, { recursive: true, force: true })
  }
})
