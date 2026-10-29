import assert from "node:assert/strict"
import { test } from "node:test"
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js"
import { BrowserManager, sharedManager } from "../src/manager"
import { options } from "../src/options"
import { filteredResult, pageTools, permissionFor, wrappedCatalog } from "../src/policy"
import type { Mcp } from "../src/mcp"
import type { BrowserProcess } from "../src/chrome"

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
  let blocked: Promise<void> | undefined
  let releaseBlock: (() => void) | undefined
  let enteredBlock: (() => void) | undefined
  const modes: boolean[] = []
  const calls: Array<{ name: string; args: Record<string, unknown> }> = []
  const tabs = new Map<string, { id: number; url: string; title: string }>()
  const cdp = { async send(name: string, args: Record<string, unknown>) {
    if (name === "Target.closeTarget") tabs.delete(args.targetId as string)
    return { success: true }
  } }
  const chrome = {
    async start(headless: boolean) {
      if (failLaunch) { failLaunch = false; throw new Error("launch failed") }
      running = true
      modes.push(headless)
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
        if (name === "get_tab_id") return structured({ tabId })
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
    manager, open, calls, tabs, modes, connect,
    advance(ms: number) { now += ms },
    fail() { failNext = true },
    failLaunch() { failLaunch = true },
    failNavigation(url: string) { failNavigationFor = url },
    crash() { running = false },
    block() {
      blocked = new Promise<void>((resolve) => { releaseBlock = resolve })
      return new Promise<void>((resolve) => { enteredBlock = resolve })
    },
    unblock() { releaseBlock?.(); blocked = undefined },
  }
}

test("status is lazy; concurrent sessions share one browser but get private handles and listings", async () => {
  const f = fixture()
  assert.equal(parse(await f.manager.execute("status", {}, caller("a"))).running, false)
  assert.equal(f.modes.length, 0)
  const [a, b] = await Promise.all([f.open("a"), f.open("b")])
  assert.notEqual(a, b)
  assert.deepEqual(f.modes, [true])
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
  assert.deepEqual(f.modes, [true])
  await f.manager.dispose()
})

test("login drains the queue, pauses all sessions, preserves handles, and requires its owner", async () => {
  const f = fixture()
  const a = await f.open("a")
  const b = await f.open("b")
  f.block()
  const operation = f.manager.execute("evaluate_script", { pageId: b }, caller("b"))
  const login = f.manager.execute("login_start", { pageId: a }, caller("a"))
  assert.deepEqual(f.modes, [true])
  f.unblock()
  await Promise.all([operation, login])
  assert.deepEqual(f.modes, [true, false])
  await assert.rejects(f.manager.execute("take_snapshot", { pageId: b }, caller("b")), /paused/)
  await assert.rejects(f.manager.execute("login_finish", {}, caller("b")), /Only the session/)
  await f.manager.execute("login_finish", {}, caller("a"))
  assert.deepEqual(f.modes, [true, false, true])
  assert.equal(parse(await f.manager.execute("evaluate_script", { pageId: b }, caller("b"))).message, "https://b.test/")
  await f.manager.dispose()
})

test("abandoned login automatically returns headless", async () => {
  const f = fixture()
  const a = await f.open("a")
  await f.manager.execute("login_start", { pageId: a }, caller("a"))
  f.advance(501)
  await f.manager.sweep()
  assert.deepEqual(f.modes, [true, false, true])
  assert.equal(parse(await f.manager.execute("status", {}, caller("a"))).paused, false)
  await f.manager.dispose()
})

test("mode switches preserve session handles and allow automation in headed and headless modes", async () => {
  const f = fixture()
  const a = await f.open("a")
  const b = await f.open("b")
  for (const mode of ["headed", "headless"] as const) {
    const switched = parse(await f.manager.execute("switch_mode", { mode }, caller("a")))
    assert.equal(switched.mode, mode)
    assert.equal(switched.changed, true)
    assert.equal(switched.paused, false)
    assert.deepEqual(switched.pages.map((page: any) => page.pageId), [a])
    const status = parse(await f.manager.execute("status", {}, caller("b")))
    assert.equal(status.mode, mode)
    assert.equal(status.paused, false)
    assert.equal(parse(await f.manager.execute("evaluate_script", { pageId: b }, caller("b"))).message, "https://b.test/")
    await assert.rejects(f.manager.execute("take_snapshot", { pageId: b }, caller("a")), /foreign page handle/)
  }
  assert.deepEqual(f.modes, [true, false, true])
  await f.manager.dispose()
})

test("already-selected modes are no-ops, including headless before Chrome has started", async () => {
  const f = fixture()
  const initial = parse(await f.manager.execute("switch_mode", { mode: "headless" }, caller("a")))
  assert.equal(initial.changed, false)
  assert.equal(initial.running, false)
  assert.deepEqual(f.modes, [])
  assert.equal(parse(await f.manager.execute("switch_mode", { mode: "headed" }, caller("a"))).changed, true)
  assert.deepEqual(f.modes, [false]) // Never launch headless just to immediately restart headed.
  const a = await f.open("a")
  assert.equal(parse(await f.manager.execute("switch_mode", { mode: "headed" }, caller("a"))).changed, false)
  assert.equal(parse(await f.manager.execute("list_pages", {}, caller("a"))).pages[0].pageId, a)
  assert.deepEqual(f.modes, [false])
  await f.manager.dispose()
})

test("invalid modes are rejected without launching or restarting Chrome", async () => {
  const f = fixture()
  for (const mode of [undefined, "visible", true, {}, "headed.extra"]) {
    await assert.rejects(f.manager.execute("switch_mode", { mode }, caller("a")), /mode must be headed or headless/)
  }
  assert.deepEqual(f.modes, [])
  await f.manager.dispose()
})

test("mode switches wait for in-flight browser operations to finish", async () => {
  const f = fixture()
  const a = await f.open("a")
  const entered = f.block()
  const reading = f.manager.execute("evaluate_script", { pageId: a }, caller("a"))
  await entered
  const switching = f.manager.execute("switch_mode", { mode: "headed" }, caller("b"))
  assert.deepEqual(f.modes, [true])
  f.unblock()
  await Promise.all([reading, switching])
  assert.deepEqual(f.modes, [true, false])
  await f.manager.dispose()
})

test("switch_mode cannot bypass a human login pause, even when requesting the current mode", async () => {
  const f = fixture()
  const a = await f.open("a")
  await f.manager.execute("login_start", { pageId: a }, caller("a"))
  assert.equal(parse(await f.manager.execute("status", {}, caller("a"))).mode, "headed")
  for (const sessionID of ["a", "b"]) {
    for (const mode of ["headed", "headless"]) {
      await assert.rejects(f.manager.execute("switch_mode", { mode }, caller(sessionID)), /paused for human login/)
    }
  }
  assert.deepEqual(f.modes, [true, false])
  await f.manager.execute("login_finish", {}, caller("a"))
  assert.equal(parse(await f.manager.execute("status", {}, caller("a"))).mode, "headless")
  await f.manager.dispose()
})

test("failed mode changes pause automation and can be retried without losing owned tabs", async () => {
  const f = fixture()
  const a = await f.open("a")
  const b = await f.open("b")
  f.failLaunch()
  await assert.rejects(f.manager.execute("switch_mode", { mode: "headed" }, caller("a")), /launch failed/)
  assert.equal(parse(await f.manager.execute("status", {}, caller("a"))).paused, true)
  await assert.rejects(f.manager.execute("take_snapshot", { pageId: a }, caller("a")), /mode transition failed/)
  // Retrying the previous mode must not be mistaken for an already-selected no-op.
  const retry = parse(await f.manager.execute("switch_mode", { mode: "headless" }, caller("a")))
  assert.equal(retry.changed, true)
  assert.equal(retry.paused, false)
  assert.equal(retry.pages[0].pageId, a)
  assert.equal(parse(await f.manager.execute("list_pages", {}, caller("b"))).pages[0].pageId, b)
  await f.manager.dispose()
})

test("restoration navigation errors keep mode changes paused and preserve every session's tabs for retry", async () => {
  const f = fixture()
  try {
    const a = await f.open("a")
    const b = await f.open("b")
    // Fail after the first session's tab has already been restored.
    f.failNavigation("https://b.test/")
    await assert.rejects(f.manager.execute("switch_mode", { mode: "headed" }, caller("a")), /restoration navigation failed/)
    assert.equal(parse(await f.manager.execute("status", {}, caller("a"))).paused, true)
    await assert.rejects(f.manager.execute("take_snapshot", { pageId: a }, caller("a")), /mode transition failed/)
    await assert.rejects(f.manager.execute("take_snapshot", { pageId: b }, caller("b")), /mode transition failed/)

    const retry = parse(await f.manager.execute("switch_mode", { mode: "headed" }, caller("a")))
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

test("releasing a session during a failed mode change never resurrects its tabs on retry", async () => {
  const f = fixture()
  await f.open("a")
  const b = await f.open("b")
  f.failLaunch()
  await assert.rejects(f.manager.execute("switch_mode", { mode: "headed" }, caller("a")), /launch failed/)
  await f.manager.release("a")
  await f.manager.execute("switch_mode", { mode: "headless" }, caller("b"))
  assert.deepEqual(parse(await f.manager.execute("status", {}, caller("a"))).pages, [])
  assert.equal(parse(await f.manager.execute("list_pages", {}, caller("b"))).pages[0].pageId, b)
  await f.manager.dispose()
})

test("idle shutdown resets the default to headless", async () => {
  const f = fixture()
  await f.manager.execute("switch_mode", { mode: "headed" }, caller("a"))
  await f.manager.release("a")
  f.advance(101)
  await f.manager.sweep()
  const status = parse(await f.manager.execute("status", {}, caller("a")))
  assert.equal(status.running, false)
  assert.equal(status.mode, "headless")
  await f.open("b")
  assert.deepEqual(f.modes, [false, true])
  await f.manager.dispose()
})

test("additive hot reload upgrades a live manager without discarding leases or tabs", async () => {
  const f = fixture()
  const a = await f.open("a")
  Reflect.deleteProperty(f.manager, "mode") // Legacy managers had no explicit mode field.
  Object.setPrototypeOf(f.manager, Object.create(BrowserManager.prototype))
  BrowserManager.upgrade(f.manager)
  assert.equal(Object.getPrototypeOf(f.manager), BrowserManager.prototype)
  assert.equal(parse(await f.manager.execute("status", {}, caller("a"))).mode, "headless")
  assert.equal(parse(await f.manager.execute("list_pages", {}, caller("a"))).pages[0].pageId, a)
  await f.manager.execute("switch_mode", { mode: "headed" }, caller("a"))
  BrowserManager.upgrade(f.manager)
  assert.equal(parse(await f.manager.execute("status", {}, caller("a"))).mode, "headed")
  assert.deepEqual(f.modes, [true, false])
  await f.manager.dispose()
})

test("upgrading a legacy manager preserves an active human-login pause", async () => {
  const f = fixture()
  const a = await f.open("a")
  await f.manager.execute("login_start", { pageId: a }, caller("a"))
  Reflect.deleteProperty(f.manager, "mode")
  BrowserManager.upgrade(f.manager)
  const status = parse(await f.manager.execute("status", {}, caller("a")))
  assert.equal(status.mode, "headed")
  assert.equal(status.paused, true)
  await assert.rejects(f.manager.execute("switch_mode", { mode: "headless" }, caller("a")), /paused for human login/)
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
  assert.deepEqual(f.modes, [true])
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
  assert.deepEqual(f.modes, [])
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

test("per-location instances share a process-wide manager and conflicting options fail", () => {
  const one = sharedManager(config())
  assert.equal(sharedManager(config()), one)
  assert.throws(() => sharedManager({ ...config(), idleTimeoutMs: 200 }), /identical options/)
})

test("all tools share one permission action and expose their operation as the resource", () => {
  for (const name of [...pageTools, "new_page", "list_pages", "close_page", "select_page", "status", "release", "login_start", "login_finish"]) {
    assert.deepEqual(permissionFor(name), { action: "browser_use", resources: [name] })
  }
  for (const mode of ["headed", "headless"]) {
    assert.deepEqual(permissionFor("switch_mode", { mode }), { action: "browser_use", resources: [`switch_mode.${mode}`] })
  }
  assert.throws(() => permissionFor("switch_mode"), /mode must be headed or headless/)
  assert.throws(() => permissionFor("switch_mode", { mode: "visible" }), /mode must be headed or headless/)
})
