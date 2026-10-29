import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { createHash } from "node:crypto"
import { BrowserRouter } from "../src/router"
import { options } from "../src/options"
import { AttachChrome } from "../src/attach-chrome"
import { Chrome } from "../src/chrome"

function fixture() {
  const root = join(tmpdir(), `browser-router-${randomUUID()}`)
  const values = new Map<string, string>()
  const store = { async get(key: string) { return values.get(key) }, async set(key: string, value: string) { values.set(key, value) }, async remove(key: string) { values.delete(key) }, async scan({ prefix }: { prefix: string }) { return { entries: [...values].filter(([key]) => key.startsWith(prefix)).map(([key, value]) => ({ key, value })) } } }
  const config = options({ profileDirectory: join(root, "profile") })
  const router = new BrowserRouter(config, store)
  return { root, values, store, config, router }
}

test("modes are per-session, persist in plugin storage, and default to shared", async () => {
  const f = fixture()
  let second: BrowserRouter | undefined
  try {
    assert.equal((await f.router.inspectPages("a")).mode, "shared")
    await f.router.setMode("a", "isolated")
    assert.equal((await f.router.inspectPages("a")).mode, "isolated")
    assert.equal((await f.router.inspectPages("b")).mode, "shared")
    second = new BrowserRouter(f.config, f.store)
    assert.equal((await second.inspectPages("a")).mode, "isolated")
    await assert.rejects(f.router.setMode("a", "unknown"), /mode must be/)
    assert.equal((await second.inspectPages("a")).mode, "isolated")
  } finally { second?.detach(); f.router.detach(); await f.router.shared.dispose(); await rm(f.root, { recursive: true, force: true }) }
})

test("legacy saved user mode resolves to attach without launching Chrome", async () => {
  const f = fixture()
  try {
    const key = `browser-mode.${createHash("sha256").update("legacy").digest("hex")}`
    f.values.set(key, "user")
    assert.equal((await f.router.inspectPages("legacy")).mode, "attach")
    assert.equal((await f.router.execute("login_start", {}, { sessionID: "legacy", directory: f.root })).content.includes("log in manually"), true)
    await f.router.setMode("legacy", "shared")
    await f.router.setMode("legacy", "attach")
    assert.equal(f.values.get(key), "attach")
  } finally { f.router.detach(); await f.router.shared.dispose(); await rm(f.root, { recursive: true, force: true }) }
})

test("mode switches close only the switching session and wait for its operations", async (t) => {
  const f = fixture()
  let unblock!: () => void
  const gate = new Promise<void>((resolve) => { unblock = resolve })
  const order: string[] = []
  t.mock.method(f.router.shared, "execute", async () => { order.push("start"); await gate; order.push("end"); return { content: "ok" } })
  t.mock.method(f.router.shared, "release", async (id: string) => { order.push(`release:${id}`) })
  try {
    const action = f.router.execute("list_pages", {}, { sessionID: "a", directory: f.root })
    const change = f.router.setMode("a", "isolated")
    await new Promise((resolve) => setImmediate(resolve))
    assert.deepEqual(order, ["start"])
    unblock()
    await Promise.all([action, change])
    assert.deepEqual(order, ["start", "end", "release:a"])
    assert.equal((await f.router.inspectPages("b")).mode, "shared")
  } finally { f.router.detach(); await f.router.shared.dispose(); await rm(f.root, { recursive: true, force: true }) }
})

test("user login never launches or restarts Chrome and visibility is unavailable", async () => {
  const f = fixture()
  try {
    await f.router.setMode("a", "attach")
    const caller = { sessionID: "a", directory: f.root }
    assert.match((await f.router.execute("login_start", { pageId: "anything" }, caller)).content, /log in manually/)
    assert.match((await f.router.execute("login_finish", {}, caller)).content, /not restarted/)
    await assert.rejects(f.router.execute("set_visibility", { visibility: "headed" }, caller), /controlled by the user/)
    const state = await f.router.inspectPages("a")
    assert.equal(state.mode, "attach")
    assert.equal(state.visibility, null)
    assert.deepEqual(state.pages, [])
  } finally { f.router.detach(); await f.router.shared.dispose(); await rm(f.root, { recursive: true, force: true }) }
})

test("switching mode or visibility while stopped never launches or connects to Chrome", async (t) => {
  const f = fixture()
  const start = t.mock.method(Chrome.prototype, "start", async () => { throw new Error("Unexpected Chrome launch") })
  const attach = t.mock.method(AttachChrome.prototype, "start", async () => { throw new Error("Unexpected Chrome attachment") })
  const registry = (globalThis as any)[Symbol.for("opencode.browser-use.router.v1")]
  const managers = new Set([f.router.shared])
  const caller = { sessionID: "a", directory: f.root }
  try {
    for (const mode of ["shared", "isolated", "attach", "shared"] as const) {
      await f.router.setMode("a", mode)
      const snapshot = await f.router.inspectPages("a")
      assert.equal(snapshot.mode, mode)
      assert.deepEqual(snapshot.pages, [])
      for (const [key, manager] of registry.managers) if (key.startsWith(f.config.profileDirectory)) managers.add(manager)
      if (mode === "attach") continue
      await f.router.execute("set_visibility", { visibility: "headed" }, caller)
      for (const manager of managers) await manager.sweep()
      assert.equal((await f.router.inspectPages("a")).visibility, "headed", "idle cleanup must preserve the selection for the next launch")
      const status = JSON.parse((await f.router.execute("status", {}, caller)).content as string)
      assert.equal(status.running, false)
      assert.equal(status.activeLeases, 0)
      await f.router.execute("set_visibility", { visibility: "headless" }, caller)
      assert.equal((await f.router.inspectPages("a")).visibility, "headless")
    }
    assert.equal(start.mock.callCount(), 0)
    assert.equal(attach.mock.callCount(), 0)
  } finally {
    f.router.detach()
    for (const manager of managers) await manager.dispose()
    await rm(f.root, { recursive: true, force: true })
  }
})

test("user attachment fails clearly without a debugging endpoint and never launches a fallback", async () => {
  const f = fixture()
  try {
    const chrome = new AttachChrome(join(f.root, "missing-chrome-profile"))
    await assert.rejects(chrome.start(true), /Enable remote debugging.*No other browser will be launched/)
    await chrome.stop()
  } finally { f.router.detach(); await f.router.shared.dispose(); await rm(f.root, { recursive: true, force: true }) }
})

test("user Chrome endpoint checks require a valid different endpoint", async () => {
  const f = fixture()
  const chrome = new AttachChrome(f.root)
  const browser = { url: "ws://127.0.0.1:1234/devtools/browser/old" } as any
  try {
    await mkdir(f.root, { recursive: true })
    assert.equal(await chrome.current(browser), true)
    await writeFile(join(f.root, "DevToolsActivePort"), "partial")
    assert.equal(await chrome.current(browser), true)
    await writeFile(join(f.root, "DevToolsActivePort"), "1234\n/devtools/browser/old\n")
    assert.equal(await chrome.current(browser), true)
    await writeFile(join(f.root, "DevToolsActivePort"), "1234\n/devtools/browser/new\n")
    assert.equal(await chrome.current(browser), false)
  } finally { f.router.detach(); await f.router.shared.dispose(); await rm(f.root, { recursive: true, force: true }) }
})

test("session deletion removes only its retained isolated profile and mode", async () => {
  const f = fixture()
  const profile = (id: string) => join(`${f.config.profileDirectory}-isolated`, createHash("sha256").update(id).digest("hex"))
  try {
    await f.router.setMode("a", "isolated")
    await f.router.setMode("b", "isolated")
    await mkdir(profile("a"), { recursive: true })
    await mkdir(profile("b"), { recursive: true })
    await writeFile(join(profile("a"), "cookie"), "a")
    await writeFile(join(profile("b"), "cookie"), "b")
    await f.router.setMode("a", "shared")
    await f.router.delete("a")
    await assert.rejects(readFile(join(profile("a"), "cookie")))
    assert.equal(await readFile(join(profile("b"), "cookie"), "utf8"), "b")
    assert.equal((await f.router.inspectPages("a")).mode, "shared")
    assert.equal((await f.router.inspectPages("b")).mode, "isolated")
  } finally { f.router.detach(); await f.router.shared.dispose(); await rm(f.root, { recursive: true, force: true }) }
})

test("session deletion continues after shared release fails and can be retried", async (t) => {
  const f = fixture()
  const profile = join(`${f.config.profileDirectory}-isolated`, createHash("sha256").update("a").digest("hex"))
  try {
    await f.router.setMode("a", "isolated")
    await mkdir(profile, { recursive: true })
    await writeFile(join(profile, "cookie"), "a")
    const release = f.router.shared.release.bind(f.router.shared)
    let failed = false
    t.mock.method(f.router.shared, "release", async (id: string) => {
      if (!failed) { failed = true; throw new Error("shared unavailable") }
      await release(id)
    })
    await assert.rejects(f.router.delete("a"), /shared unavailable/)
    await assert.rejects(readFile(join(profile, "cookie")))
    assert.equal(f.values.size, 2)
    await assert.rejects(f.router.inspectPages("a"), /deletion is pending/)
    await f.router.delete("a")
    assert.equal(f.values.size, 0)
  } finally { f.router.detach(); await f.router.shared.dispose(); await rm(f.root, { recursive: true, force: true }) }
})

test("persisted deletion is recovered after router restart", async (t) => {
  const f = fixture()
  let second: BrowserRouter | undefined
  try {
    await f.router.setMode("a", "isolated")
    t.mock.method(f.router.shared, "release", async () => { throw new Error("unavailable") })
    await assert.rejects(f.router.delete("a"), /unavailable/)
    t.mock.restoreAll()
    f.router.detach()
    second = new BrowserRouter(f.config, f.store)
    await second.recoverDeletions()
    for (let i = 0; i < 100 && f.values.size; i++) await new Promise((resolve) => setTimeout(resolve, 10))
    assert.equal(f.values.size, 0)
  } finally { second?.detach(); f.router.detach(); await f.router.shared.dispose(); await rm(f.root, { recursive: true, force: true }) }
})

test("live cleanup retries a transient failure", async (t) => {
  const f = fixture()
  const release = f.router.shared.release.bind(f.router.shared)
  let attempts = 0
  t.mock.method(console, "error", () => {})
  t.mock.method(f.router.shared, "release", async (id: string) => {
    if (++attempts === 1) throw new Error("temporary")
    await release(id)
  })
  try {
    await f.router.scheduleDeletion("a")
    for (let i = 0; i < 650 && (attempts < 2 || f.values.size); i++) await new Promise((resolve) => setTimeout(resolve, 10))
    assert.equal(attempts, 2)
    assert.equal(f.values.size, 0)
  } finally { f.router.detach(); await f.router.shared.dispose(); await rm(f.root, { recursive: true, force: true }) }
})

test("idle isolated manager is evicted across routers and can be recreated", async () => {
  const f = fixture()
  const second = new BrowserRouter(f.config, f.store)
  const registry = (globalThis as any)[Symbol.for("opencode.browser-use.router.v1")]
  const profile = join(`${f.config.profileDirectory}-isolated`, createHash("sha256").update("a").digest("hex"))
  try {
    await f.router.setMode("a", "isolated")
    await f.router.inspectPages("a")
    await second.inspectPages("a")
    const old = registry.managers.get(profile)
    await old.sweep()
    assert.equal(old.isRetired, true)
    assert.equal(registry.managers.has(profile), false)
    await second.inspectPages("a")
    assert.notEqual(registry.managers.get(profile), old)
  } finally { second.detach(); f.router.detach(); await f.router.shared.dispose(); await rm(f.root, { recursive: true, force: true }) }
})

test("profile removal holds an external lock against another service", async () => {
  const f = fixture()
  const first = new Chrome(f.config)
  const second = new Chrome(f.config)
  let entered!: () => void
  let unblock!: () => void
  const ready = new Promise<void>((resolve) => { entered = resolve })
  const gate = new Promise<void>((resolve) => { unblock = resolve })
  ;(first as any).recover = async () => { entered(); await gate; return undefined }
  try {
    const removal = first.removeProfile()
    await ready
    await assert.rejects(second.removeProfile(), /managed by another OpenCode service/)
    unblock()
    await removal
    await second.removeProfile()
  } finally { unblock(); f.router.detach(); await f.router.shared.dispose(); await rm(f.root, { recursive: true, force: true }) }
})

test("per-session queues are discarded after all queued operations finish", async () => {
  const f = fixture()
  const registry = (globalThis as any)[Symbol.for("opencode.browser-use.router.v1")]
  const key = `${f.config.profileDirectory}:queue-test`
  try {
    await Promise.all([f.router.inspectPages("queue-test"), f.router.inspectPages("queue-test")])
    // Queue bookkeeping runs after the last operation settles.
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(registry.queues.has(key), false)
  } finally { f.router.detach(); await f.router.shared.dispose(); await rm(f.root, { recursive: true, force: true }) }
})
