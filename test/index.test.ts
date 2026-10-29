import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import plugin from "../src/index"
import { sharedManager } from "../src/manager"
import { options } from "../src/options"

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
