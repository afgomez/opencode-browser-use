import assert from "node:assert/strict"
import { test } from "node:test"
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js"
import { BrowserManager, sharedManager } from "../src/manager"
import { options } from "../src/options"
import { filteredResult, pageTools, permissionFor, wrappedCatalog } from "../src/policy"
import type { Mcp } from "../src/mcp"
import type { BrowserProcess } from "../src/chrome"
import { emptySnapshot } from "../src/rpc"
import { Cdp } from "../src/cdp"

const config = () => options({ profileDirectory: "/test/browser", idleTimeoutMs: 100, leaseTimeoutMs: 1000, loginTimeoutMs: 500, unloadGraceMs: 200 })
const caller = (sessionID: string, signal?: AbortSignal) => ({ sessionID, directory: "/workspace", signal })
const structured = (value: Record<string, unknown>): CallToolResult => ({ content: [{ type: "text", text: "UNFILTERED GLOBAL SECRETS" }], structuredContent: value })
function parse(result: Awaited<ReturnType<BrowserManager["execute"]>>) {
  const content = result.content
  return JSON.parse(typeof content === "string" ? content : content[0].type === "text" ? content[0].text : "{}")
}

function fixture() {
  let now = 0
  let next = 1
  let running = false
  let failNext = false
  let failLaunch = false
  let failNavigationFor: string | undefined
  let failCdp = false
  let failIdentification = false
  let current = true
  let blocked: Promise<void> | undefined
  let releaseBlock: (() => void) | undefined
  let enteredBlock: (() => void) | undefined
  const headlessLaunches: boolean[] = []
  const calls: Array<{ name: string; args: Record<string, unknown> }> = []
  const cdpCalls: string[] = []
  const tabs = new Map<string, { id: number; url: string; title: string }>()
  const cdp = { async send(name: string, args: Record<string, unknown>) {
    cdpCalls.push(name)
    if (failCdp) { failCdp = false; throw new Error("Chrome disconnected") }
    if (name === "Target.getTargets") return { targetInfos: [...tabs].map(([targetId, tab]) => ({ targetId, type: "tab", title: tab.title, url: tab.url })) }
    if (name === "Target.closeTarget") tabs.delete(args.targetId as string)
    return { success: true }
  } }
  const chrome = {
    async current() { return current },
    async start(headless: boolean) {
      if (failLaunch) { failLaunch = false; throw new Error("launch failed") }
      running = true
      headlessLaunches.push(headless)
      tabs.set(`tab-${next}`, { id: next++, url: "about:blank", title: "unowned" })
      return { url: "http://fake", cdp, alive: () => running, async stop() {} } as unknown as BrowserProcess
    },
    async stop() { running = false; tabs.clear() },
  }
  const connect = async (): Promise<Mcp> => {
    // Reconnects are allowed to renumber every MCP page.
    for (const tab of tabs.values()) tab.id = next++
    return {
      async tools() { return [] }, async roots() {}, async close() {},
      async call(name, args, signal) {
        calls.push({ name, args })
        if (failNext) { failNext = false; throw new Error("connection lost") }
        if (name === "list_pages") return structured({ pages: [...tabs.values()] })
        if (name === "new_page") {
          tabs.set(`tab-${next}`, { id: next++, url: args.url as string, title: "owned" })
          return structured({ pages: [...tabs.values()] })
        }
        const found = [...tabs].find(([, tab]) => tab.id === args.pageId)
        if (!found) throw new Error("Unknown upstream page")
        const [tabId, tab] = found
        if (name === "get_tab_id") {
          if (failIdentification) { failIdentification = false; throw new Error("identification failed") }
          return structured({ tabId })
        }
        if (name === "navigate_page") {
          if (failNavigationFor !== undefined && args.url === failNavigationFor) {
            failNavigationFor = undefined
            return { ...structured({ errorMessage: "restoration navigation failed" }), isError: true }
          }
          tab.url = args.url as string
          return structured({ pages: [...tabs.values()] })
        }
        if (blocked && name === "evaluate_script") {
          enteredBlock?.()
          await blocked
          signal?.throwIfAborted()
        }
        return structured({ message: tab.url, pages: [...tabs.values()], openedPages: [...tabs.values()] })
      },
    }
  }
  const manager = new BrowserManager(config(), { chrome, connect, now: () => now })
  const open = async (sessionID: string, url = `https://${sessionID}.test/`) => {
    const result = parse(await manager.execute("new_page", { url }, caller(sessionID)))
    return result.pages.at(-1).pageId as string
  }
  return {
    manager, open, calls, cdpCalls, tabs, headlessLaunches, connect,
    advance(ms: number) { now += ms },
    fail() { failNext = true },
    failLaunch() { failLaunch = true },
    failNavigation(url: string) { failNavigationFor = url },
    failCdp() { failCdp = true },
    failIdentification() { failIdentification = true },
    crash() { running = false },
    replace() { current = false },
    block() {
      blocked = new Promise<void>((resolve) => { releaseBlock = resolve })
      return new Promise<void>((resolve) => { enteredBlock = resolve })
    },
    unblock() { releaseBlock?.(); blocked = undefined },
  }
}

test("pending markers are discarded after a confirmed browser crash", async () => {
  const f = fixture()
  try {
    f.failIdentification()
    await assert.rejects(f.open("a"), /identification failed/)
    f.crash()
    await f.manager.release("a")
    await f.manager.sweep()
    assert.equal(parse(await f.manager.execute("status", {}, caller("a"))).leaseHeld, false)
  } finally { await f.manager.dispose() }
})

test("a confirmed changed endpoint invalidates old handles without adopting unknown tabs", async () => {
  const f = fixture()
  try {
    const old = await f.open("a")
    f.replace()
    assert.deepEqual((await f.manager.inspectPages("a")).pages, [])
    await assert.rejects(f.manager.execute("select_page", { pageId: old }, caller("a")), /Unknown, closed, or foreign/)
    assert.deepEqual(parse(await f.manager.execute("list_pages", {}, caller("a"))).pages, [])
  } finally { await f.manager.dispose() }
})

test("failed tab identification leaves a recoverable marker and release closes only that tab", async () => {
  const f = fixture()
  try {
    await f.open("b")
    f.failIdentification()
    await assert.rejects(f.open("a"), /identification failed/)
    assert.equal([...f.tabs.values()].filter((tab) => tab.url.startsWith("about:blank#opencode-browser-use-")).length, 1)
    f.failCdp()
    await assert.rejects(f.manager.release("a"), /disconnected/)
    assert.equal([...f.tabs.values()].filter((tab) => tab.url.startsWith("about:blank#opencode-browser-use-")).length, 1)
    await f.manager.release("a")
    assert.equal([...f.tabs.values()].filter((tab) => tab.url.startsWith("about:blank#opencode-browser-use-")).length, 0)
    assert.ok([...f.tabs.values()].some((tab) => tab.url === "https://b.test/"))
  } finally { await f.manager.dispose() }
})

test("a disconnected metadata transport preserves ownership until reconnect succeeds", async (t) => {
  const f = fixture()
  let disconnected = false
  let reconnectFails = true
  t.mock.method(Cdp, "disconnected", () => disconnected)
  t.mock.method(Cdp, "reconnect", async () => {
    if (reconnectFails) throw new Error("reconnect failed")
    disconnected = false
  })
  try {
    const pageId = await f.open("a")
    disconnected = true
    await assert.rejects(f.manager.release("a"), /reconnect failed/)
    await f.manager.sweep()
    assert.equal(parse(await f.manager.execute("status", {}, caller("a"))).pages[0].pageId, pageId)
    reconnectFails = false
    await f.manager.release("a")
    assert.equal(parse(await f.manager.execute("status", {}, caller("a"))).pages.length, 0)
    assert.ok(![...f.tabs.values()].some((tab) => tab.url === "https://a.test/"))
  } finally { await f.manager.dispose() }
})

test("status is lazy; concurrent sessions share one browser but get private handles and listings", async () => {
  const f = fixture()
  assert.equal(parse(await f.manager.execute("status", {}, caller("a"))).running, false)
  assert.equal(f.headlessLaunches.length, 0)
  const [a, b] = await Promise.all([f.open("a"), f.open("b")])
  assert.notEqual(a, b)
  assert.deepEqual(f.headlessLaunches, [true])
  for (const [sessionID, pageId] of [["a", a], ["b", b]]) {
    const result = await f.manager.execute("list_pages", {}, caller(sessionID))
    assert.deepEqual(parse(result).pages.map((p: any) => p.pageId), [pageId])
    assert.ok(!JSON.stringify(result).includes("GLOBAL SECRETS"))
  }
  await f.manager.dispose()
})

test("every page operation rejects foreign, numeric, and invented handles", async () => {
  const f = fixture()
  const a = await f.open("a")
  await f.open("b")
  const names = ["evaluate_script", "take_snapshot", "take_screenshot", "navigate_page", "click", "close_page", "select_page", "get_network_request", "list_console_messages", "login_start"]
  for (const name of names) {
    for (const pageId of [a, 1, "invented"]) {
      const before = f.calls.length
      await assert.rejects(f.manager.execute(name, { pageId }, caller("b")), /foreign page handle/)
      assert.equal(f.calls.length, before, `${name} must reject before a page operation`)
    }
  }
  await assert.rejects(f.manager.execute("evaluate_script", { pageId: a, serviceWorkerId: "sw-1" }, caller("a")), /Service-worker/)
  await assert.rejects(f.manager.execute("select_page", { pageId: a, bringToFront: true }, caller("a")), /explicit headed handoff/)
  await f.manager.dispose()
})

test("sidebar inspection is lazy and never creates a lease or launches Chrome", async () => {
  const f = fixture()
  try {
    assert.deepEqual(await f.manager.inspectPages("a"), emptySnapshot())
    assert.deepEqual(f.headlessLaunches, [])
    assert.deepEqual(f.cdpCalls, [])
    assert.deepEqual(f.calls, [])
    assert.equal(parse(await f.manager.execute("status", {}, caller("a"))).activeLeases, 0)
    await assert.rejects(f.manager.inspectPages(""), /session ID/)
  } finally { await f.manager.dispose() }
})

test("sidebar inspection uses live metadata but exposes only the requested session's owned handles", async () => {
  const f = fixture()
  try {
    const a = await f.open("a")
    await f.open("b", "https://b-private.test/")
    const tab = [...f.tabs].find(([, tab]) => tab.url === "https://a.test/")!
    tab[1].title = "New page title"
    tab[1].url = "https://a.test/changed-by-human"
    f.tabs.set("popup", { id: 99, title: "Unknown popup", url: "https://popup-private.test/" })
    const before = f.calls.length
    assert.deepEqual(await f.manager.inspectPages("a"), {
      ...emptySnapshot(),
      pages: [{ pageId: a, title: "New page title", url: "https://a.test/changed-by-human" }],
    })
    assert.equal(f.calls.length, before, "inspection must not call MCP or change its selected page")
    assert.deepEqual(f.cdpCalls, ["Target.getTargets"])
    assert.deepEqual(await f.manager.inspectPages("unknown"), emptySnapshot())
    f.tabs.delete(tab[0])
    assert.deepEqual(await f.manager.inspectPages("a"), emptySnapshot())
  } finally { await f.manager.dispose() }
})

test("sidebar polling cannot keep leases or an idle browser alive", async () => {
  const f = fixture()
  try {
    await f.open("a")
    for (let i = 0; i < 4; i++) { f.advance(300); await f.manager.inspectPages("a") }
    await f.manager.sweep()
    assert.equal(parse(await f.manager.execute("status", {}, caller("a"))).leaseHeld, false)
    assert.deepEqual(await f.manager.inspectPages("a"), emptySnapshot())
    f.advance(101)
    await f.manager.inspectPages("a")
    await f.manager.sweep()
    assert.equal(parse(await f.manager.execute("status", {}, caller("a"))).running, false)
    assert.deepEqual(f.headlessLaunches, [true])
  } finally { await f.manager.dispose() }
})

test("sidebar reads remain passive during login, crash, release, and failed restoration", async () => {
  const f = fixture()
  try {
    const a = await f.open("a")
    await f.manager.execute("login_start", { pageId: a }, caller("a"))
    assert.equal((await f.manager.inspectPages("a")).pages[0].pageId, a)
    assert.equal((await f.manager.inspectPages("a")).visibility, "headed")
    assert.equal((await f.manager.inspectPages("a")).paused, true)
    assert.equal(parse(await f.manager.execute("status", {}, caller("a"))).paused, true)
    await assert.rejects(f.manager.execute("take_snapshot", { pageId: a }, caller("a")), /paused/)
    await f.manager.execute("login_finish", {}, caller("a"))
    f.failLaunch()
    await assert.rejects(f.manager.execute("set_visibility", { visibility: "headed" }, caller("a")), /launch failed/)
    assert.deepEqual(await f.manager.inspectPages("a"), { ...emptySnapshot(), paused: true })
    await f.manager.execute("set_visibility", { visibility: "headless" }, caller("a"))
    assert.equal((await f.manager.inspectPages("a")).pages[0].pageId, a)
    await f.manager.release("a")
    assert.deepEqual(await f.manager.inspectPages("a"), emptySnapshot())
    await f.open("a")
    f.crash()
    const before = f.headlessLaunches.length
    assert.deepEqual(await f.manager.inspectPages("a"), emptySnapshot())
    assert.equal(f.headlessLaunches.length, before)
  } finally { await f.manager.dispose() }
})

test("sidebar reads serialize with operations and queued cancellation has no browser side effects", async () => {
  const f = fixture()
  try {
    const a = await f.open("a")
    const entered = f.block()
    const operation = f.manager.execute("evaluate_script", { pageId: a }, caller("a"))
    await entered
    const controller = new AbortController()
    const cancelled = f.manager.inspectPages("a", controller.signal)
    const inspection = f.manager.inspectPages("a")
    assert.deepEqual(f.cdpCalls, [])
    controller.abort()
    f.unblock()
    await operation
    await assert.rejects(cancelled, /abort/i)
    assert.equal((await inspection).pages[0].pageId, a)
    assert.deepEqual(f.cdpCalls, ["Target.getTargets"])
    f.failCdp()
    await assert.rejects(f.manager.inspectPages("a"), /disconnected/)
    assert.equal((await f.manager.inspectPages("a")).pages[0].pageId, a)
    assert.deepEqual(f.headlessLaunches, [true])
  } finally { f.unblock(); await f.manager.dispose() }
})

test("reads return scoped structured content, not global MCP text or page inventories", async () => {
  const f = fixture()
  const a = await f.open("a")
  await f.open("b", "https://private-b.test/")
  const result = await f.manager.execute("evaluate_script", { pageId: a, function: "() => location.href" }, caller("a"))
  assert.equal(parse(result).message, "https://a.test/")
  assert.ok(!JSON.stringify(result).includes("private-b"))
  assert.ok(!JSON.stringify(result).includes("openedPages"))
  assert.ok(!JSON.stringify(result).includes("GLOBAL SECRETS"))
  await f.manager.dispose()
})

test("MCP failure is not retried; reconnect remaps tab identities instead of trusting indexes", async () => {
  const f = fixture()
  const a = await f.open("a")
  await f.open("b")
  f.fail()
  await assert.rejects(f.manager.execute("take_snapshot", { pageId: a }, caller("a")), /connection lost/)
  const result = await f.manager.execute("evaluate_script", { pageId: a }, caller("a"))
  assert.equal(parse(result).message, "https://a.test/")
  assert.deepEqual(f.headlessLaunches, [true])
  await f.manager.dispose()
})

test("login drains the queue, pauses all sessions, preserves handles, and requires its owner", async () => {
  const f = fixture()
  const a = await f.open("a")
  const b = await f.open("b")
  f.block()
  const operation = f.manager.execute("evaluate_script", { pageId: b }, caller("b"))
  const login = f.manager.execute("login_start", { pageId: a }, caller("a"))
  assert.deepEqual(f.headlessLaunches, [true])
  f.unblock()
  await Promise.all([operation, login])
  assert.deepEqual(f.headlessLaunches, [true, false])
  await assert.rejects(f.manager.execute("take_snapshot", { pageId: b }, caller("b")), /paused/)
  await assert.rejects(f.manager.execute("login_finish", {}, caller("b")), /Only the session/)
  await f.manager.execute("login_finish", {}, caller("a"))
  assert.deepEqual(f.headlessLaunches, [true, false, true])
  assert.equal(parse(await f.manager.execute("evaluate_script", { pageId: b }, caller("b"))).message, "https://b.test/")
  await f.manager.dispose()
})

test("abandoned login automatically returns headless", async () => {
  const f = fixture()
  const a = await f.open("a")
  await f.manager.execute("login_start", { pageId: a }, caller("a"))
  f.advance(501)
  await f.manager.sweep()
  assert.deepEqual(f.headlessLaunches, [true, false, true])
  assert.equal(parse(await f.manager.execute("status", {}, caller("a"))).paused, false)
  await f.manager.dispose()
})

test("visibility switches preserve session handles and allow automation both headed and headless", async () => {
  const f = fixture()
  const a = await f.open("a")
  const b = await f.open("b")
  for (const visibility of ["headed", "headless"] as const) {
    const switched = parse(await f.manager.execute("set_visibility", { visibility }, caller("a")))
    assert.equal(switched.visibility, visibility)
    assert.equal(switched.changed, true)
    assert.equal(switched.paused, false)
    assert.deepEqual(switched.pages.map((page: any) => page.pageId), [a])
    const status = parse(await f.manager.execute("status", {}, caller("b")))
    assert.equal(status.visibility, visibility)
    assert.equal(status.paused, false)
    assert.equal(parse(await f.manager.execute("evaluate_script", { pageId: b }, caller("b"))).message, "https://b.test/")
    await assert.rejects(f.manager.execute("take_snapshot", { pageId: b }, caller("a")), /foreign page handle/)
  }
  assert.deepEqual(f.headlessLaunches, [true, false, true])
  await f.manager.dispose()
})

test("already-selected visibility settings are no-ops, including headless before Chrome has started", async () => {
  const f = fixture()
  const initial = parse(await f.manager.execute("set_visibility", { visibility: "headless" }, caller("a")))
  assert.equal(initial.changed, false)
  assert.equal(initial.running, false)
  assert.deepEqual(f.headlessLaunches, [])
  assert.equal(parse(await f.manager.execute("set_visibility", { visibility: "headed" }, caller("a"))).changed, true)
  assert.deepEqual(f.headlessLaunches, [], "changing a stopped browser's visibility must not launch Chrome")
  assert.equal(parse(await f.manager.execute("status", {}, caller("a"))).activeLeases, 0)
  const a = await f.open("a")
  assert.equal(parse(await f.manager.execute("set_visibility", { visibility: "headed" }, caller("a"))).changed, false)
  assert.equal(parse(await f.manager.execute("list_pages", {}, caller("a"))).pages[0].pageId, a)
  assert.deepEqual(f.headlessLaunches, [false])
  await f.manager.dispose()
})

test("invalid visibility settings are rejected without launching or restarting Chrome", async () => {
  const f = fixture()
  for (const visibility of [undefined, "visible", true, {}, "headed.extra"]) {
    await assert.rejects(f.manager.execute("set_visibility", { visibility }, caller("a")), /visibility must be headed or headless/)
  }
  assert.deepEqual(f.headlessLaunches, [])
  await f.manager.dispose()
})

test("stopped visibility choices survive inspection and sweeps until the first browser operation", async () => {
  const f = fixture()
  f.manager.evictWhenIdle = true
  try {
    for (const visibility of ["headed", "headless", "headed"] as const) {
      const changed = parse(await f.manager.execute("set_visibility", { visibility }, caller("a")))
      assert.equal(changed.running, false)
      assert.equal(changed.changed, true)
      assert.deepEqual(f.headlessLaunches, [])
      assert.equal((await f.manager.inspectPages("a")).visibility, visibility)
      const status = parse(await f.manager.execute("status", {}, caller("a")))
      assert.equal(status.activeLeases, 0)
      assert.equal(status.leaseHeld, false)
    }
    f.advance(2000)
    await f.manager.sweep()
    assert.equal(f.manager.isRetired, false)
    assert.equal((await f.manager.inspectPages("a")).visibility, "headed")
    assert.deepEqual(f.headlessLaunches, [])
    await f.open("a")
    assert.deepEqual(f.headlessLaunches, [false])
  } finally { await f.manager.dispose() }
})

test("changing visibility after a crash configures the next launch without restarting Chrome", async () => {
  const f = fixture()
  try {
    await f.open("a")
    f.crash()
    const changed = parse(await f.manager.execute("set_visibility", { visibility: "headed" }, caller("b")))
    assert.equal(changed.running, false)
    assert.equal(changed.visibility, "headed")
    assert.equal(parse(await f.manager.execute("status", {}, caller("b"))).leaseHeld, false)
    assert.deepEqual(f.headlessLaunches, [true])
    await f.open("b")
    assert.deepEqual(f.headlessLaunches, [true, false])
  } finally { await f.manager.dispose() }
})

test("visibility switches wait for in-flight browser operations to finish", async () => {
  const f = fixture()
  const a = await f.open("a")
  const entered = f.block()
  const reading = f.manager.execute("evaluate_script", { pageId: a }, caller("a"))
  await entered
  const switching = f.manager.execute("set_visibility", { visibility: "headed" }, caller("b"))
  assert.deepEqual(f.headlessLaunches, [true])
  f.unblock()
  await Promise.all([reading, switching])
  assert.deepEqual(f.headlessLaunches, [true, false])
  await f.manager.dispose()
})

test("set_visibility cannot bypass a human login pause, even when requesting the current visibility", async () => {
  const f = fixture()
  const a = await f.open("a")
  await f.manager.execute("login_start", { pageId: a }, caller("a"))
  assert.equal(parse(await f.manager.execute("status", {}, caller("a"))).visibility, "headed")
  for (const sessionID of ["a", "b"]) {
    for (const visibility of ["headed", "headless"]) {
      await assert.rejects(f.manager.execute("set_visibility", { visibility }, caller(sessionID)), /paused for human login/)
    }
  }
  assert.deepEqual(f.headlessLaunches, [true, false])
  await f.manager.execute("login_finish", {}, caller("a"))
  assert.equal(parse(await f.manager.execute("status", {}, caller("a"))).visibility, "headless")
  await f.manager.dispose()
})

test("failed visibility changes pause automation and can be retried without losing owned tabs", async () => {
  const f = fixture()
  const a = await f.open("a")
  const b = await f.open("b")
  f.failLaunch()
  await assert.rejects(f.manager.execute("set_visibility", { visibility: "headed" }, caller("a")), /launch failed/)
  assert.equal(parse(await f.manager.execute("status", {}, caller("a"))).paused, true)
  await assert.rejects(f.manager.execute("take_snapshot", { pageId: a }, caller("a")), /visibility transition failed/)
  // Retrying the previous visibility must not be mistaken for an already-selected no-op.
  const retry = parse(await f.manager.execute("set_visibility", { visibility: "headless" }, caller("a")))
  assert.equal(retry.changed, true)
  assert.equal(retry.paused, false)
  assert.equal(retry.pages[0].pageId, a)
  assert.equal(parse(await f.manager.execute("list_pages", {}, caller("b"))).pages[0].pageId, b)
  await f.manager.dispose()
})

test("restoration navigation errors keep visibility changes paused and preserve every session's tabs for retry", async () => {
  const f = fixture()
  try {
    const a = await f.open("a")
    const b = await f.open("b")
    // Fail after the first session's tab has already been restored.
    f.failNavigation("https://b.test/")
    await assert.rejects(f.manager.execute("set_visibility", { visibility: "headed" }, caller("a")), /restoration navigation failed/)
    assert.equal(parse(await f.manager.execute("status", {}, caller("a"))).paused, true)
    await assert.rejects(f.manager.execute("take_snapshot", { pageId: a }, caller("a")), /visibility transition failed/)
    await assert.rejects(f.manager.execute("take_snapshot", { pageId: b }, caller("b")), /visibility transition failed/)

    const retry = parse(await f.manager.execute("set_visibility", { visibility: "headed" }, caller("a")))
    assert.equal(retry.changed, true)
    assert.equal(retry.paused, false)
    for (const [sessionID, pageId] of [["a", a], ["b", b]]) {
      const pages = parse(await f.manager.execute("list_pages", {}, caller(sessionID))).pages
      assert.deepEqual(pages.map((page: any) => ({ pageId: page.pageId, url: page.url })), [{ pageId, url: `https://${sessionID}.test/` }])
    }
  } finally { await f.manager.dispose() }
})

for (const phase of ["login_start", "login_finish"] as const) {
  test(`${phase} navigation errors preserve the login pause and saved tabs until recovery succeeds`, async () => {
    const f = fixture()
    try {
      const a = await f.open("a")
      const b = await f.open("b")
      if (phase === "login_finish") await f.manager.execute("login_start", { pageId: a }, caller("a"))
      f.failNavigation("https://b.test/")
      await assert.rejects(f.manager.execute(phase, phase === "login_start" ? { pageId: a } : {}, caller("a")), /restoration navigation failed/)
      const status = parse(await f.manager.execute("status", {}, caller("a")))
      assert.equal(status.paused, true)
      assert.equal(status.loginOwnedByThisSession, true)
      await assert.rejects(f.manager.execute("take_snapshot", { pageId: b }, caller("b")), /paused for human login/)

      await f.manager.execute("login_finish", {}, caller("a"))
      assert.equal(parse(await f.manager.execute("status", {}, caller("a"))).paused, false)
      for (const [sessionID, pageId] of [["a", a], ["b", b]]) {
        const pages = parse(await f.manager.execute("list_pages", {}, caller(sessionID))).pages
        assert.deepEqual(pages.map((page: any) => ({ pageId: page.pageId, url: page.url })), [{ pageId, url: `https://${sessionID}.test/` }])
      }
    } finally { await f.manager.dispose() }
  })
}

test("releasing a session during a failed visibility change never resurrects its tabs on retry", async () => {
  const f = fixture()
  await f.open("a")
  const b = await f.open("b")
  f.failLaunch()
  await assert.rejects(f.manager.execute("set_visibility", { visibility: "headed" }, caller("a")), /launch failed/)
  await f.manager.release("a")
  await f.manager.execute("set_visibility", { visibility: "headless" }, caller("b"))
  assert.deepEqual(parse(await f.manager.execute("status", {}, caller("a"))).pages, [])
  assert.equal(parse(await f.manager.execute("list_pages", {}, caller("b"))).pages[0].pageId, b)
  await f.manager.dispose()
})

test("idle shutdown resets the default to headless", async () => {
  const f = fixture()
  await f.manager.execute("set_visibility", { visibility: "headed" }, caller("a"))
  await f.open("a")
  await f.manager.release("a")
  f.advance(101)
  await f.manager.sweep()
  const status = parse(await f.manager.execute("status", {}, caller("a")))
  assert.equal(status.running, false)
  assert.equal(status.visibility, "headless")
  await f.open("b")
  assert.deepEqual(f.headlessLaunches, [false, true])
  await f.manager.dispose()
})

for (const cleanup of ["release", "lease expiry"] as const) {
  test(`idle cleanup resets a failed restart without Chrome after ${cleanup}`, async () => {
    const f = fixture()
    const detach = f.manager.attach()
    try {
      await f.manager.execute("set_visibility", { visibility: "headed" }, caller("a"))
      await f.open("a")
      f.failLaunch()
      await assert.rejects(f.manager.execute("set_visibility", { visibility: "headless" }, caller("a")), /launch failed/)
      if (cleanup === "release") await f.manager.release("a")
      else { f.advance(1001); await f.manager.sweep() }

      f.advance(99)
      await f.manager.sweep()
      const waiting = parse(await f.manager.execute("status", {}, caller("a")))
      assert.equal(waiting.running, false)
      assert.equal(waiting.activeLeases, 0)
      assert.equal(waiting.paused, true)

      f.advance(2)
      await f.manager.sweep()
      const cleaned = parse(await f.manager.execute("status", {}, caller("a")))
      assert.equal(cleaned.running, false)
      assert.equal(cleaned.paused, false)
      assert.equal(cleaned.visibility, "headless")
      assert.deepEqual(cleaned.pages, [])
      await f.open("b")
      assert.deepEqual(f.headlessLaunches, [false, true])
      assert.deepEqual(parse(await f.manager.execute("list_pages", {}, caller("a"))).pages, [])
    } finally { detach(); await f.manager.dispose() }
  })
}

test("idle cleanup does not discard failed restoration while another session holds a lease", async () => {
  const f = fixture()
  try {
    await f.open("a")
    const b = await f.open("b")
    f.failLaunch()
    await assert.rejects(f.manager.execute("set_visibility", { visibility: "headed" }, caller("a")), /launch failed/)
    await f.manager.release("a")
    f.advance(101)
    await f.manager.sweep()
    const status = parse(await f.manager.execute("status", {}, caller("b")))
    assert.equal(status.paused, true)
    assert.equal(status.leaseHeld, true)
    await f.manager.execute("set_visibility", { visibility: "headless" }, caller("b"))
    const pages = parse(await f.manager.execute("list_pages", {}, caller("b"))).pages
    assert.equal(pages[0].pageId, b)
    assert.equal(pages[0].url, "https://b.test/")
  } finally { await f.manager.dispose() }
})

test("unload cleanup retires a failed restart after releasing its leases and waiting for idle", async () => {
  const f = fixture()
  const detach = f.manager.attach()
  try {
    await f.open("a")
    f.failLaunch()
    await assert.rejects(f.manager.execute("set_visibility", { visibility: "headed" }, caller("a")), /launch failed/)
    detach()
    f.advance(201)
    await f.manager.sweep()
    f.advance(101)
    await f.manager.sweep()
    const status = parse(await f.manager.execute("status", {}, caller("a")))
    assert.equal(status.running, false)
    assert.equal(status.activeLeases, 0)
    assert.equal(status.paused, false)
    assert.throws(() => f.manager.attach(), /unloaded/)
  } finally { detach(); await f.manager.dispose() }
})

test("additive hot reload upgrades a live manager without discarding leases or tabs", async () => {
  const f = fixture()
  const a = await f.open("a")
  Reflect.deleteProperty(f.manager, "visibility") // Legacy managers had no explicit visibility field.
  Object.setPrototypeOf(f.manager, Object.create(BrowserManager.prototype))
  BrowserManager.upgrade(f.manager)
  assert.equal(Object.getPrototypeOf(f.manager), BrowserManager.prototype)
  assert.equal(parse(await f.manager.execute("status", {}, caller("a"))).visibility, "headless")
  assert.equal(parse(await f.manager.execute("list_pages", {}, caller("a"))).pages[0].pageId, a)
  await f.manager.execute("set_visibility", { visibility: "headed" }, caller("a"))
  BrowserManager.upgrade(f.manager)
  assert.equal(parse(await f.manager.execute("status", {}, caller("a"))).visibility, "headed")
  assert.deepEqual(f.headlessLaunches, [true, false])
  await f.manager.dispose()
})

for (const visibility of ["headed", "headless"] as const) {
  test(`hot reload migrates legacy browser visibility ${visibility} without restarting or losing handles`, async () => {
    const f = fixture()
    try {
      const a = await f.open("a")
      await f.manager.execute("set_visibility", { visibility }, caller("a"))
      const before = [...f.headlessLaunches]
      // Model a live instance from before the terminology change.
      Reflect.set(f.manager, "mode", visibility)
      Reflect.deleteProperty(f.manager, "visibility")
      BrowserManager.upgrade(f.manager)
      const status = parse(await f.manager.execute("status", {}, caller("a")))
      assert.equal(status.visibility, visibility)
      assert.equal(status.paused, false)
      assert.equal(status.leaseHeld, true)
      assert.ok(!("mode" in status))
      assert.equal(Reflect.has(f.manager, "mode"), false)
      assert.equal((await f.manager.inspectPages("a")).visibility, visibility)
      assert.equal((await f.manager.inspectPages("a")).pages[0].pageId, a)
      const unchanged = parse(await f.manager.execute("set_visibility", { visibility }, caller("a")))
      assert.equal(unchanged.changed, false)
      assert.deepEqual(f.headlessLaunches, before)
      // Later reloads must preserve the new field rather than a stale legacy value.
      Reflect.set(f.manager, "mode", visibility === "headed" ? "headless" : "headed")
      BrowserManager.upgrade(f.manager)
      assert.equal(parse(await f.manager.execute("status", {}, caller("a"))).visibility, visibility)
      assert.equal(Reflect.has(f.manager, "mode"), false)
    } finally { await f.manager.dispose() }
  })
}

test("upgrading a legacy manager preserves an active human-login pause", async () => {
  const f = fixture()
  const a = await f.open("a")
  await f.manager.execute("login_start", { pageId: a }, caller("a"))
  Reflect.deleteProperty(f.manager, "visibility")
  BrowserManager.upgrade(f.manager)
  const status = parse(await f.manager.execute("status", {}, caller("a")))
  assert.equal(status.visibility, "headed")
  assert.equal(status.paused, true)
  await assert.rejects(f.manager.execute("set_visibility", { visibility: "headless" }, caller("a")), /paused for human login/)
  await f.manager.dispose()
})

test("reloading after relocation refreshes the private MCP connector without restarting Chrome", async () => {
  const f = fixture()
  const a = await f.open("a")
  let reconnectedFromNewLocation = false
  BrowserManager.upgrade(f.manager, async () => {
    reconnectedFromNewLocation = true
    return f.connect()
  })
  f.fail()
  await assert.rejects(f.manager.execute("take_snapshot", { pageId: a }, caller("a")), /connection lost/)
  const result = await f.manager.execute("evaluate_script", { pageId: a }, caller("a"))
  assert.equal(reconnectedFromNewLocation, true)
  assert.equal(parse(result).message, "https://a.test/")
  assert.deepEqual(f.headlessLaunches, [true])
  await f.manager.dispose()
})

test("lease expiry and explicit release leave other sessions alive, then stop after idle grace", async () => {
  const f = fixture()
  await f.open("a")
  f.advance(600)
  const b = await f.open("b")
  f.advance(500)
  await f.manager.sweep()
  assert.equal(parse(await f.manager.execute("status", {}, caller("a"))).leaseHeld, false)
  assert.equal(parse(await f.manager.execute("status", {}, caller("b"))).running, true)
  assert.equal(parse(await f.manager.execute("list_pages", {}, caller("b"))).pages[0].pageId, b)
  await f.manager.execute("release", {}, caller("b"))
  f.advance(101)
  await f.manager.sweep()
  assert.equal(parse(await f.manager.execute("status", {}, caller("b"))).running, false)
  await f.manager.dispose()
})

test("reload/unload references retain the manager and tabs across the unload grace period", async () => {
  const f = fixture()
  const detach = f.manager.attach()
  const a = await f.open("a")
  detach()
  f.advance(100)
  const reloaded = f.manager.attach()
  f.advance(150)
  await f.manager.sweep()
  assert.equal(parse(await f.manager.execute("list_pages", {}, caller("a"))).pages[0].pageId, a)
  reloaded()
  f.advance(201)
  await f.manager.sweep()
  f.advance(101)
  await f.manager.sweep()
  assert.equal(parse(await f.manager.execute("status", {}, caller("a"))).running, false)
  await f.manager.dispose()
})

test("browser crashes invalidate old handles without adopting restored or unknown tabs", async () => {
  const f = fixture()
  const a = await f.open("a")
  f.crash()
  await assert.rejects(f.manager.execute("take_snapshot", { pageId: a }, caller("a")), /foreign page handle/)
  assert.deepEqual(parse(await f.manager.execute("list_pages", {}, caller("a"))).pages, [])
  await f.manager.dispose()
})

test("cancellation in the queue never starts a browser operation", async () => {
  const f = fixture()
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(f.manager.execute("new_page", { url: "https://a.test" }, caller("a", controller.signal)), /abort/i)
  assert.deepEqual(f.headlessLaunches, [])
  await f.manager.dispose()
})

test("catalog is allowlisted, enforces string handles, and removes service-worker escapes", () => {
  const inputSchema = { type: "object" as const, properties: { pageId: { type: "number" }, serviceWorkerId: { type: "string" } } }
  const catalog = wrappedCatalog([
    { name: "evaluate_script", inputSchema }, { name: "install_extension", inputSchema }, { name: "future_unknown_tool", inputSchema },
  ])
  assert.equal(catalog.length, 1)
  assert.equal((catalog[0].inputSchema.properties!.pageId as any).type, "string")
  assert.ok(!("serviceWorkerId" in catalog[0].inputSchema.properties!))
  assert.deepEqual(catalog[0].inputSchema.required, ["pageId"])
  assert.equal((inputSchema.properties.pageId as any).type, "number")
})

test("error results cannot leak raw global page text; screenshots remain attachments", () => {
  assert.throws(() => filteredResult({ isError: true, content: [{ type: "text", text: "SECRET TAB URL" }] }, []), /^Error: Chrome MCP tool failed$/)
  const result = filteredResult({ ...structured({ message: "ok", pages: ["SECRET"] }), content: [{ type: "image", data: "AAAA", mimeType: "image/png" }] }, [])
  assert.equal(result.content[1].type, "file")
  assert.ok(!JSON.stringify(result).includes("SECRET"))
})

test("per-location instances share a process-wide manager and conflicting options fail", async () => {
  const one = sharedManager(config())
  const detach = one.attach()
  try {
    assert.equal(sharedManager(config()), one)
    assert.throws(() => sharedManager({ ...config(), idleTimeoutMs: 200 }), /identical options/)
    // Explicit shutdown must not remove a manager still held by a loaded location.
    await one.dispose()
    assert.equal(sharedManager(config()), one)
    assert.throws(() => sharedManager({ ...config(), idleTimeoutMs: 200 }), /identical options/)
  } finally { detach(); await one.dispose() }
})

test("disposed shared managers allow new options without letting stale owners evict or restart them", async () => {
  const original = { ...config(), profileDirectory: "/test/shared-disposed" }
  const one = sharedManager(original)
  await one.dispose()
  const updated = { ...original, idleTimeoutMs: 200 }
  const two = sharedManager(updated)
  const detach = two.attach()
  try {
    assert.notEqual(two, one)
    assert.deepEqual(two.config, updated)
    assert.throws(() => one.attach(), /unloaded/)
    await assert.rejects(one.execute("new_page", { url: "https://stale.test/" }, caller("stale")), /unloaded/)
    await one.dispose()
    await one.sweep()
    assert.equal(sharedManager(updated), two)
  } finally { detach(); await two.dispose() }
})

test("fully unloaded shared managers allow new options after the unload grace period", async (t) => {
  let now = 0
  t.mock.method(Date, "now", () => now)
  const original = { ...config(), profileDirectory: "/test/shared-unloaded" }
  const updated = { ...original, leaseTimeoutMs: 2000 }
  const one = sharedManager(original)
  const detach = one.attach()
  detach()
  try {
    now = original.unloadGraceMs - 1
    await one.sweep()
    assert.equal(sharedManager(original), one)
    assert.throws(() => sharedManager(updated), /identical options/)

    now += 2
    await one.sweep()
    const two = sharedManager(updated)
    try {
      assert.notEqual(two, one)
      assert.deepEqual(two.config, updated)
      assert.throws(() => one.attach(), /unloaded/)
    } finally { await two.dispose() }
  } finally { await one.dispose() }
})

test("all tools share one permission action and expose their operation as the resource", () => {
  for (const name of [...pageTools, "new_page", "list_pages", "close_page", "select_page", "status", "release", "login_start", "login_finish"]) {
    assert.deepEqual(permissionFor(name), { action: "browser_use", resources: [name] })
  }
})
