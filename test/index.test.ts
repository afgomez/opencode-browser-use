import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import plugin from "../src/index"
import { sharedManager } from "../src/manager"
import { options } from "../src/options"
import { BrowserUse, emptySnapshot } from "../src/rpc"

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
    assert.deepEqual(released, ["first", "second"])
    const errors = logged.mock.calls.map((call) => call.arguments).filter(([message]) => String(message).startsWith("[browser-use]"))
    assert.deepEqual(errors, [["[browser-use] Session cleanup failed", failure]])
  } finally {
    if (cleanup) await cleanup()
    await manager.dispose()
  }
})

test("the sidebar RPC delegates only passive inspection with the requested session and cancellation signal", async (t) => {
  const input = { profileDirectory: join(tmpdir(), "opencode", `browser-use-sidebar-${randomUUID()}`) }
  const manager = sharedManager(options(input))
  const snapshot = { ...emptySnapshot(), pages: [{ pageId: "owned", title: "Flows", url: "https://example.test/" }] }
  const inspect = t.mock.method(manager, "inspectPages", async () => snapshot)
  let pages!: (input: unknown, context: { signal: AbortSignal }) => Promise<unknown>
  const ctx = {
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
    assert.deepEqual(await pages({ sessionID: "viewed-session" }, { signal: controller.signal }), snapshot)
    assert.deepEqual(inspect.mock.calls[0].arguments, ["viewed-session", controller.signal])
  } finally {
    if (cleanup) await cleanup()
    await manager.dispose()
  }
})

test("sidebar mode changes bypass agent permissions while agent tools still enforce deny rules", async (t) => {
  const input = { profileDirectory: join(tmpdir(), "opencode", `browser-use-mode-${randomUUID()}`) }
  const manager = sharedManager(options(input))
  let fail = false
  const execute = t.mock.method(manager, "execute", async () => {
    if (fail) throw new Error("Browser automation is paused for human login")
    return { content: "{}" }
  })
  let switchMode!: (input: unknown, context: { signal: AbortSignal; error(type: string, message: string, data: unknown): unknown }) => Promise<unknown>
  let agentSwitch!: (input: unknown, context: unknown) => Promise<unknown>
  const assertions: any[] = []
  const ctx = {
    options: input, location: { directory: tmpdir() },
    rpc: { async register(_definition: unknown, handlers: { switchMode: typeof switchMode }) { switchMode = handlers.switchMode } },
    permission: { async assert(value: unknown) {
      assertions.push(value)
      throw new Error("Permission denied")
    } },
    tool: { async transform(edit: (editor: unknown) => void) {
      edit({ namespace() {}, add(tool: { name: string; execute: typeof agentSwitch }) { if (tool.name === "switch_mode") agentSwitch = tool.execute } })
    } },
    session: { async hook() {} }, event: { async *subscribe() {} },
  } as unknown as Parameters<typeof plugin.setup>[0]
  let cleanup: Awaited<ReturnType<typeof plugin.setup>> = undefined
  try {
    cleanup = await plugin.setup(ctx)
    const controller = new AbortController()
    const context = { signal: controller.signal, error: (type: string, message: string, data: unknown) => ({ type, message, data }) }
    for (const mode of ["headed", "headless"]) {
      assert.deepEqual(await switchMode({ sessionID: "viewed-session", mode }, context), {})
      assert.deepEqual(execute.mock.calls.at(-1)!.arguments, ["switch_mode", { mode }, {
        sessionID: "viewed-session", directory: tmpdir(), signal: controller.signal,
      }])
    }
    assert.equal(assertions.length, 0, "direct user actions must not evaluate ask or deny rules")
    await assert.rejects(agentSwitch({ mode: "headed" }, {
      sessionID: "viewed-session", agent: "build", messageID: "message", id: "tool", signal: controller.signal,
    }), /Permission denied/)
    assert.equal(assertions[0].action, "browser_use")
    assert.deepEqual(assertions[0].resources, ["switch_mode.headed"])
    assert.equal(execute.mock.callCount(), 2)
    controller.abort()
    await switchMode({ sessionID: "viewed-session", mode: "headed" }, context)
    assert.equal(execute.mock.callCount(), 2, "cancelled user actions cannot execute the switch")
    fail = true
    const rejected = await switchMode({ sessionID: "viewed-session", mode: "headed" }, { ...context, signal: new AbortController().signal }) as { type: string; message: string }
    assert.equal(rejected.type, "switch_failed")
    assert.match(rejected.message, /paused for human login/, "UI actions still obey browser lifecycle constraints")
  } finally {
    if (cleanup) await cleanup()
    await manager.dispose()
  }
})
