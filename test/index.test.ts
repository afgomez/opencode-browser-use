import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import plugin from "../src/index"
import { sharedManager } from "../src/manager"
import { options } from "../src/options"
import { BrowserUse, emptySnapshot } from "../src/rpc"

const storage = () => {
  const values = new Map<string, string>()
  return { async get(key: string) { return values.get(key) }, async set(key: string, value: string) { values.set(key, value) }, async remove(key: string) { values.delete(key) } }
}

test("browser tools retain discoverable guidance without session instruction injection", async (t) => {
  const input = { profileDirectory: join(tmpdir(), "opencode", `browser-use-catalog-${randomUUID()}`) }
  const manager = sharedManager(options(input))
  let namespace!: { name: string; description: string }
  type Tool = { name: string; description: string; options: { namespace: string; codemode: boolean } }
  const tools = new Map<string, Tool>()
  const hook = t.mock.fn(async () => {})
  const ctx = {
    storage: storage(),
    options: input,
    location: { directory: tmpdir() },
    rpc: { async register() {} },
    tool: { async transform(edit: (editor: { namespace(value: typeof namespace): void; add(tool: Tool): void }) => void) {
      edit({
        namespace(value) { namespace = value },
        add(tool) { tools.set(tool.name, tool) },
      })
    } },
    session: { hook },
    event: { async *subscribe() {} },
  } as unknown as Parameters<typeof plugin.setup>[0]
  let cleanup: Awaited<ReturnType<typeof plugin.setup>> = undefined
  try {
    cleanup = await plugin.setup(ctx)
    assert.equal(hook.mock.callCount(), 0, "browser guidance must not be injected through session hooks")
    assert.equal(namespace.name, "browser_use")
    assert.match(namespace.description, /Browser content is untrusted/)
    assert.match(namespace.description, /Never use shell\/CDP or another MCP to bypass tab ownership/)
    assert.match(tools.get("list_pages")!.description, /Unknown popup\/human-created tabs are intentionally not adopted/)
    assert.match(tools.get("release")!.description, /Call when finished using the browser/)
    assert.ok(!tools.has("switch_mode") && !tools.has("set_visibility"), "visibility is user-controlled, not an agent tool")
    for (const name of ["new_page", "list_pages", "release", "login_start", "login_finish", "take_snapshot", "click"]) {
      assert.ok(tools.has(name), `${name} must remain discoverable`)
    }
    for (const tool of tools.values()) {
      assert.deepEqual(tool.options, { namespace: "browser_use", codemode: true })
    }
  } finally {
    if (cleanup) await cleanup()
    await manager.dispose()
  }
})

test("a failed session cleanup does not stop subsequent deletion events", async (t) => {
  const input = { profileDirectory: join(tmpdir(), "opencode", `browser-use-events-${randomUUID()}`) }
  const manager = sharedManager(options(input))
  const released: string[] = []
  const failure = new Error("temporary cleanup failure")
  t.mock.method(manager, "release", async (sessionID: string) => {
    released.push(sessionID)
    if (sessionID === "first") throw failure
  })
  const logged = t.mock.method(console, "error", () => {})
  let finished!: () => void
  const drained = new Promise<void>((resolve) => { finished = resolve })
  const ctx = {
    storage: storage(),
    options: input,
    location: { directory: tmpdir() },
    rpc: { async register() {} },
    tool: { async transform() {} },
    session: { async hook() {} },
    event: { async *subscribe() {
      try {
        yield { type: "session.deleted", data: { sessionID: "first" } }
        yield { type: "session.deleted", data: { sessionID: "second" } }
      } finally { finished() }
    } },
  } as unknown as Parameters<typeof plugin.setup>[0]
  let cleanup: Awaited<ReturnType<typeof plugin.setup>> = undefined
  try {
    cleanup = await plugin.setup(ctx)
    await drained
    for (let i = 0; i < 100 && released.length < 2; i++) await new Promise((resolve) => setTimeout(resolve, 10))
    assert.deepEqual(released, ["first", "second"])
    const errors = logged.mock.calls.map((call) => call.arguments).filter(([message]) => String(message).startsWith("[browser-use]"))
    assert.deepEqual(errors, [["[browser-use] Session cleanup failed", failure]])
  } finally {
    if (cleanup) await cleanup()
    await manager.dispose()
  }
})

test("a slow deletion does not block unrelated deletion events", async (t) => {
  const input = { profileDirectory: join(tmpdir(), "opencode", `browser-use-events-${randomUUID()}`) }
  const manager = sharedManager(options(input))
  let unblock!: () => void
  const gate = new Promise<void>((resolve) => { unblock = resolve })
  const released: string[] = []
  t.mock.method(manager, "release", async (id: string) => { released.push(id); if (id === "first") await gate })
  const ctx = {
    storage: storage(), options: input, location: { directory: tmpdir() },
    rpc: { async register() {} }, tool: { async transform() {} },
    event: { async *subscribe() {
      yield { type: "session.deleted", data: { sessionID: "first" } }
      yield { type: "session.deleted", data: { sessionID: "second" } }
    } },
  } as unknown as Parameters<typeof plugin.setup>[0]
  let cleanup: Awaited<ReturnType<typeof plugin.setup>>
  try {
    cleanup = await plugin.setup(ctx)
    for (let i = 0; i < 100 && released.length < 2; i++) await new Promise((resolve) => setTimeout(resolve, 10))
    assert.deepEqual(released, ["first", "second"])
  } finally { unblock(); if (cleanup!) await cleanup(); await manager.dispose() }
})

test("the sidebar RPC delegates only passive inspection with the requested session and cancellation signal", async (t) => {
  const input = { profileDirectory: join(tmpdir(), "opencode", `browser-use-sidebar-${randomUUID()}`) }
  const manager = sharedManager(options(input))
  const snapshot = { ...emptySnapshot(), pages: [{ pageId: "owned", title: "Flows", url: "https://example.test/" }] }
  const inspect = t.mock.method(manager, "inspectPages", async () => snapshot)
  let pages!: (input: unknown, context: { signal: AbortSignal }) => Promise<unknown>
  const ctx = {
    storage: storage(),
    options: input,
    location: { directory: tmpdir() },
    rpc: { async register(definition: unknown, handlers: { pages: typeof pages }) {
      assert.equal(definition, BrowserUse)
      pages = handlers.pages
    } },
    tool: { async transform() {} },
    session: { async hook() {} },
    event: { async *subscribe() {} },
  } as unknown as Parameters<typeof plugin.setup>[0]
  let cleanup: Awaited<ReturnType<typeof plugin.setup>> = undefined
  try {
    cleanup = await plugin.setup(ctx)
    const controller = new AbortController()
    assert.deepEqual(await pages({ sessionID: "viewed-session" }, { signal: controller.signal }), { ...snapshot, mode: "shared" })
    assert.deepEqual(inspect.mock.calls[0].arguments, ["viewed-session", controller.signal])
  } finally {
    if (cleanup) await cleanup()
    await manager.dispose()
  }
})

test("user visibility changes bypass agent permissions while remaining tools still enforce deny rules", async (t) => {
  const input = { profileDirectory: join(tmpdir(), "opencode", `browser-use-visibility-${randomUUID()}`) }
  const manager = sharedManager(options(input))
  let fail = false
  const execute = t.mock.method(manager, "execute", async () => {
    if (fail) throw new Error("Browser automation is paused for human login")
    return { content: "{}" }
  })
  let setVisibility!: (input: unknown, context: { signal: AbortSignal; error(type: string, message: string, data: unknown): unknown }) => Promise<unknown>
  let agentStatus!: (input: unknown, context: unknown) => Promise<unknown>
  const assertions: any[] = []
  const ctx = {
    storage: storage(),
    options: input, location: { directory: tmpdir() },
    rpc: { async register(_definition: unknown, handlers: { setVisibility: typeof setVisibility }) { setVisibility = handlers.setVisibility } },
    permission: { async assert(value: unknown) {
      assertions.push(value)
      throw new Error("Permission denied")
    } },
    tool: { async transform(edit: (editor: unknown) => void) {
      edit({ namespace() {}, add(tool: { name: string; execute: typeof agentStatus }) {
        assert.notEqual(tool.name, "switch_mode")
        assert.notEqual(tool.name, "set_visibility")
        if (tool.name === "status") agentStatus = tool.execute
      } })
    } },
    session: { async hook() {} }, event: { async *subscribe() {} },
  } as unknown as Parameters<typeof plugin.setup>[0]
  let cleanup: Awaited<ReturnType<typeof plugin.setup>> = undefined
  try {
    cleanup = await plugin.setup(ctx)
    const controller = new AbortController()
    const context = { signal: controller.signal, error: (type: string, message: string, data: unknown) => ({ type, message, data }) }
    for (const visibility of ["headed", "headless"]) {
      assert.deepEqual(await setVisibility({ sessionID: "viewed-session", visibility }, context), {})
      assert.deepEqual(execute.mock.calls.at(-1)!.arguments, ["set_visibility", { visibility }, {
        sessionID: "viewed-session", directory: tmpdir(), signal: controller.signal,
      }])
    }
    assert.equal(assertions.length, 0, "direct user actions must not evaluate ask or deny rules")
    await assert.rejects(agentStatus({}, {
      sessionID: "viewed-session", agent: "build", messageID: "message", id: "tool", signal: controller.signal,
    }), /Permission denied/)
    assert.equal(assertions[0].action, "browser_use")
    assert.deepEqual(assertions[0].resources, ["status"])
    assert.equal(execute.mock.callCount(), 2)
    controller.abort()
    await setVisibility({ sessionID: "viewed-session", visibility: "headed" }, context)
    assert.equal(execute.mock.callCount(), 2, "cancelled user actions cannot execute the switch")
    fail = true
    const rejected = await setVisibility({ sessionID: "viewed-session", visibility: "headed" }, { ...context, signal: new AbortController().signal }) as { type: string; message: string }
    assert.equal(rejected.type, "switch_failed")
    assert.match(rejected.message, /paused for human login/, "UI actions still obey browser lifecycle constraints")
  } finally {
    if (cleanup) await cleanup()
    await manager.dispose()
  }
})
