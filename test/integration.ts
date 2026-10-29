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
import { AttachChrome } from "../src/attach-chrome"
import { BrowserRouter } from "../src/router"

test("real Chrome + private MCP: concurrency, scope, screenshots, cookies, restarts, locks, cleanup", { timeout: 180_000 }, async () => {
  const base = join(tmpdir(), "opencode")
  await mkdir(base, { recursive: true })
  const directory = await mkdtemp(join(base, "browser-use-test-"))
  const config = options({ profileDirectory: join(directory, "profile") })
  const chrome = new Chrome(config)
  // Exercise visibility switching and the complete login protocol without opening a window or stealing
  // focus during automated tests. Actual headed UI is a separate manual check.
  const headlessLaunches: boolean[] = []
  let browser!: BrowserProcess
  const manager = new BrowserManager(config, { chrome: {
    start: async (headless) => { headlessLaunches.push(headless); return browser = await chrome.start(true) }, stop: (release) => chrome.stop(release),
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
    assert.deepEqual(headlessLaunches, [])
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
    assert.deepEqual(headlessLaunches, [true], "repairing metadata must not restart Chrome")
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
    const headed = parse(await manager.execute("set_visibility", { visibility: "headed" }, a))
    assert.equal(headed.visibility, "headed")
    assert.equal(headed.paused, false)
    assert.deepEqual(headed.pages.map((page: any) => page.pageId), [pageA])
    assert.equal(parse(await manager.execute("status", {}, b)).visibility, "headed")
    const visibleSnapshot = await manager.execute("take_snapshot", { pageId: pageB }, b)
    assert.match(JSON.stringify(visibleSnapshot), /b-private/)
    const beforeNoop = headlessLaunches.length
    assert.equal(parse(await manager.execute("set_visibility", { visibility: "headed" }, a)).changed, false)
    assert.equal(headlessLaunches.length, beforeNoop)
    await manager.execute("set_visibility", { visibility: "headless" }, b)
    assert.deepEqual(headlessLaunches, [true, false, true])
    assert.equal(parse(await manager.execute("list_pages", {}, a)).pages[0].pageId, pageA)
    await manager.execute("login_start", { pageId: pageA }, a)
    assert.equal((await manager.inspectPages(a.sessionID)).pages[0].pageId, pageA)
    assert.equal(parse(await manager.execute("status", {}, a)).paused, true)
    await assert.rejects(manager.execute("take_snapshot", { pageId: pageB }, b), /paused/)
    await assert.rejects(manager.execute("set_visibility", { visibility: "headless" }, b), /paused for human login/)
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

test("attaching to a disposable existing Chrome only closes plugin-owned tabs and disconnects", { timeout: 120_000 }, async () => {
  const base = join(tmpdir(), "opencode")
  await mkdir(base, { recursive: true })
  const directory = await mkdtemp(join(base, "browser-attach-test-"))
  const config = options({ profileDirectory: join(directory, "profile") })
  const chrome = new Chrome(config)
  const manager = new BrowserManager(config, { chrome: new AttachChrome(config.profileDirectory) })
  try {
    const browser = await chrome.start(true)
    const before = await browser.cdp.send<{ targetInfos: Array<{ targetId: string }> }>("Target.getTargets", { filter: [{ type: "tab" }] })
    const caller = { sessionID: "attached", directory }
    const result = await manager.execute("new_page", { url: "about:blank" }, caller)
    const text = typeof result.content === "string" ? result.content : result.content.find((item) => item.type === "text")?.text
    assert.equal(JSON.parse(text!).pages.length, 1)
    await manager.execute("release", {}, caller)
    await manager.dispose()
    assert.equal(browser.alive(), true, "disconnect must not terminate the attached Chrome")
    const after = await browser.cdp.send<{ targetInfos: Array<{ targetId: string }> }>("Target.getTargets", { filter: [{ type: "tab" }] })
    for (const target of before.targetInfos) assert.ok(after.targetInfos.some((item) => item.targetId === target.targetId), "existing user tabs remain untouched")
  } finally {
    await manager.dispose()
    await chrome.stop()
    await rm(directory, { recursive: true, force: true })
  }
})

test("isolated sessions have independent cookies retained after switching away", { timeout: 120_000 }, async () => {
  const base = join(tmpdir(), "opencode")
  await mkdir(base, { recursive: true })
  const directory = await mkdtemp(join(base, "browser-isolation-test-"))
  const config = options({ profileDirectory: join(directory, "profile") })
  const values = new Map<string, string>()
  const storage = { async get(key: string) { return values.get(key) }, async set(key: string, value: string) { values.set(key, value) }, async remove(key: string) { values.delete(key) } }
  const router = new BrowserRouter(config, storage)
  const server = createServer((request, response) => {
    if (request.url === "/set") response.setHeader("Set-Cookie", "private_cookie=secret; Max-Age=3600; Path=/")
    response.end("ok")
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  const a = { sessionID: "isolated-a", directory }
  const b = { sessionID: "isolated-b", directory }
  const c = { sessionID: "shared-c", directory }
  const parse = (result: any) => JSON.parse(typeof result.content === "string" ? result.content : result.content[0].text)
  try {
    await router.setMode(a.sessionID, "isolated")
    await router.setMode(b.sessionID, "isolated")
    const pageA = parse(await router.execute("new_page", { url: `${origin}/set` }, a)).pages[0].pageId
    const pageB = parse(await router.execute("new_page", { url: origin }, b)).pages[0].pageId
    const pageC = parse(await router.execute("new_page", { url: origin }, c)).pages[0].pageId
    const unsafe = parse(await router.execute("new_page", { url: "data:text/html,unsafe" }, a)).pages.find((page: any) => page.pageId !== pageA).pageId
    assert.doesNotMatch(JSON.stringify(await router.execute("evaluate_script", { pageId: pageB, function: "() => document.cookie" }, b)), /private_cookie/)
    await router.execute("navigate_page", { pageId: pageA, url: origin }, a)
    await router.setMode(a.sessionID, "shared")
    assert.equal((await router.inspectPages(b.sessionID)).pages[0].pageId, pageB)
    const transferred = (await router.inspectPages(a.sessionID)).pages
    assert.equal(transferred[0].pageId, pageA)
    assert.equal(transferred[1].pageId, unsafe)
    assert.match(transferred[1].url, /^about:blank/)
    assert.equal((await router.inspectPages(c.sessionID)).pages[0].pageId, pageC)
    assert.doesNotMatch(JSON.stringify(await router.execute("evaluate_script", { pageId: pageA, function: "() => document.cookie" }, a)), /private_cookie/)
    await router.setMode(a.sessionID, "isolated")
    assert.equal((await router.inspectPages(a.sessionID)).pages[0].pageId, pageA)
    assert.equal((await router.inspectPages(c.sessionID)).pages[0].pageId, pageC)
    assert.match(JSON.stringify(await router.execute("evaluate_script", { pageId: pageA, function: "() => document.cookie" }, a)), /private_cookie=secret/)
  } finally {
    await router.delete(a.sessionID)
    await router.delete(b.sessionID)
    await router.delete(c.sessionID)
    router.detach()
    await router.shared.dispose()
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
    await utimes(`${profileDirectory}.opencode-browser-use.lock`, past, past)
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
