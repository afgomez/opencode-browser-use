import assert from "node:assert/strict"
import { createHash, randomUUID } from "node:crypto"
import { mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test, type TestContext } from "node:test"
import { setImmediate as flushAsync } from "node:timers/promises"
import { BrowserRouter } from "../src/router"
import { options } from "../src/options"
import { AttachChrome } from "../src/attach-chrome"
import { Chrome } from "../src/chrome"
import { BrowserManager } from "../src/manager"

type RouterRegistry = {
  managers: Map<string, BrowserManager>
  queues: Map<string, unknown>
  transfers: Map<string, { source: BrowserManager; destination: BrowserManager }>
}

function registry<T>(name: string): T {
  return (globalThis as unknown as Record<symbol, T>)[Symbol.for(name)]!
}

const hash = (id: string) => createHash("sha256").update(id).digest("hex")

function fixture(t: TestContext) {
  const root = join(tmpdir(), `browser-router-${randomUUID()}`)
  const values = new Map<string, string>()
  const store = { async get(key: string) { return values.get(key) }, async set(key: string, value: string) { values.set(key, value) }, async remove(key: string) { values.delete(key) }, async scan({ prefix }: { prefix: string }) { return { entries: [...values].filter(([key]) => key.startsWith(prefix)).map(([key, value]) => ({ key, value })) } } }
  const config = options({ profileDirectory: join(root, "profile") })
  const managers = new Set<BrowserManager>()
  const routers = new Set<BrowserRouter>()
  const state = registry<RouterRegistry>("opencode.browser-use.router.v1")
  const shared = registry<Map<string, BrowserManager>>("opencode.browser-use.managers.v1")
  const profile = (id: string) => join(`${config.profileDirectory}-isolated`, hash(id))
  const key = (id: string) => `${config.profileDirectory}:${id}`
  const modeKey = (id: string) => `browser-mode.${hash(id)}`
  const owns = (key: string) => key.startsWith(`${config.profileDirectory}:`) || key.startsWith(`${config.profileDirectory}-isolated/`)
  t.after(async () => {
    t.mock.restoreAll()
    for (const router of routers) router.detach() // Also cancels deletion retry timers.
    for (const [key, transfer] of state.transfers) {
      if (!owns(key)) continue
      const id = key.slice(config.profileDirectory.length + 1)
      for (const manager of [transfer.source, transfer.destination]) {
        managers.add(manager)
        manager.unpinTransfer(id)
      }
      state.transfers.delete(key)
    }
    for (const [key, manager] of state.managers) {
      if (!owns(key)) continue
      managers.add(manager)
      state.managers.delete(key)
    }
    try {
      const results = await Promise.allSettled([...managers].map((manager) => manager.dispose()))
      const errors = results.filter((result) => result.status === "rejected").map((result) => result.reason)
      if (errors.length) throw new AggregateError(errors, "Fixture manager cleanup failed")
    } finally {
      if (managers.has(shared.get(config.profileDirectory)!)) shared.delete(config.profileDirectory)
      for (const key of state.queues.keys()) if (owns(key)) state.queues.delete(key)
      await rm(root, { recursive: true, force: true })
    }
  })
  function createRouter() {
    const router = new BrowserRouter(config, store)
    routers.add(router)
    managers.add(router.shared)
    // Track each attachment, including managers later evicted or replaced.
    const internal = router as unknown as { attach(manager: BrowserManager): BrowserManager }
    const attach = internal.attach.bind(router)
    internal.attach = (manager) => { managers.add(manager); return attach(manager) }
    return router
  }
  const router = createRouter()
  async function destination(id = "a", restoreShared = true) {
    await router.setMode(id, "isolated")
    if (restoreShared) await router.setMode(id, "shared")
    const manager = state.managers.get(profile(id))
    assert.ok(manager)
    return manager
  }
  function attachedManager() {
    const manager = new BrowserManager(config, { chrome: new AttachChrome() })
    managers.add(manager)
    state.managers.set(key("user"), manager)
    return manager
  }
  return { root, values, store, config, router, registry: state, managers, profile, key, modeKey, createRouter, destination, attachedManager }
}

test("modes are per-session, persist in plugin storage, and default to shared", async (t) => {
  const f = fixture(t)
  assert.equal((await f.router.inspectPages("a")).mode, "shared")
  await f.router.setMode("a", "isolated")
  assert.equal((await f.router.inspectPages("a")).mode, "isolated")
  assert.equal((await f.router.inspectPages("b")).mode, "shared")
  const second = f.createRouter()
  assert.equal((await second.inspectPages("a")).mode, "isolated")
  await assert.rejects(f.router.setMode("a", "unknown"), /mode must be/)
  assert.equal((await second.inspectPages("a")).mode, "isolated")
})

test("legacy saved user mode reuses its live manager without migrating on inspection", async (t) => {
  const f = fixture(t)
  const managerKey = f.key("user")
  const manager = f.attachedManager()
  const writes = t.mock.method(f.store, "set")
  const inspect = t.mock.method(manager, "inspectPages")
  const release = t.mock.method(manager, "release")
  const key = f.modeKey("legacy")
  f.values.set(key, "user")
  assert.equal((await f.router.inspectPages("legacy")).mode, "attach")
  assert.equal(inspect.mock.callCount(), 1)
  assert.equal(f.registry.managers.get(managerKey), manager)
  assert.equal(writes.mock.callCount(), 0)
  assert.equal(f.values.get(key), "user")
  assert.equal((await f.router.execute("login_start", {}, { sessionID: "legacy", directory: f.root })).content.includes("log in manually"), true)
  await assert.rejects(f.router.setMode("legacy", "user"), /mode must be/)
  await f.router.setMode("legacy", "shared")
  await f.router.setMode("legacy", "attach")
  assert.equal(f.values.get(key), "attach")
  await f.router.delete("legacy")
  assert.equal(release.mock.callCount(), 2, "switching and deletion must release the legacy manager")
})

test("mode switches close only the switching session and wait for its operations", async (t) => {
  const f = fixture(t)
  let unblock!: () => void
  const gate = new Promise<void>((resolve) => { unblock = resolve })
  const order: string[] = []
  t.mock.method(f.router.shared, "execute", async () => { order.push("start"); await gate; order.push("end"); return { content: "ok" } })
  t.mock.method(f.router.shared, "releaseSession", async (id: string) => { order.push(`release:${id}`) })
  try {
    const action = f.router.execute("list_pages", {}, { sessionID: "a", directory: f.root })
    const change = f.router.setMode("a", "isolated")
    await new Promise((resolve) => setImmediate(resolve))
    assert.deepEqual(order, ["start"])
    unblock()
    await Promise.all([action, change])
    assert.deepEqual(order, ["start", "end", "release:a"])
    assert.equal((await f.router.inspectPages("b")).mode, "shared")
  } finally { unblock() }
})

test("switch recovery retains source on preparation failure and resolves uncertain persistence without replay", async (t) => {
  const f = fixture(t)
  const destination = await f.destination()
  const pages = [{ pageId: "stable", url: "https://example.test/", title: "" }]
  t.mock.method(f.router.shared, "inspectTransfer", async () => ({ visibility: "headless" as const, paused: false, pages }))
  let prepares = 0, sourceReleases = 0, destinationReleases = 0, failPrepare = true
  t.mock.method(destination, "prepareTransferLocked", async (_id: string, input: typeof pages) => {
    prepares++
    assert.deepEqual(input, pages)
    if (failPrepare) throw new Error("prepare failed")
  })
  t.mock.method(destination, "validateTransfer", async () => {})
  t.mock.method(destination, "releaseSession", async () => { destinationReleases++ })
  t.mock.method(f.router.shared, "releaseSession", async () => { sourceReleases++ })
  await assert.rejects(f.router.setMode("a", "isolated"), /prepare failed/)
  assert.equal(sourceReleases, 0)
  assert.equal(destinationReleases, 1)
  failPrepare = false
  const set = f.store.set.bind(f.store)
  t.mock.method(f.store, "set", async (key: string, value: string) => { await set(key, value); throw new Error("write response lost") })
  await assert.rejects(f.router.setMode("a", "isolated"), /write response lost/)
  assert.equal(sourceReleases, 1)
  assert.equal(prepares, 2)
  assert.equal((await f.router.inspectPages("a")).mode, "isolated")
  assert.equal(prepares, 2, "uncertain writes must not replay navigation")
})

test("partial source cleanup blocks operations until retried, without repeating preparation", async (t) => {
  const f = fixture(t)
  const dest = await f.destination()
  let attempts = 0, prepares = 0, fail = true
  t.mock.method(dest, "prepareTransferLocked", async () => { prepares++ })
  t.mock.method(f.router.shared, "releaseSession", async () => { attempts++; if (fail) throw new Error("source cleanup failed") })
  await assert.rejects(f.router.setMode("a", "isolated"), /switch incomplete/)
  assert.equal(attempts, 2)
  await assert.rejects(f.router.inspectPages("a"), /source cleanup failed/)
  assert.equal(prepares, 1)
  fail = false
  assert.equal((await f.router.inspectPages("a")).mode, "isolated")
  assert.equal(prepares, 1)
  assert.equal(f.registry.transfers.has(f.key("a")), false)
})

test("cancelled preparation cleans destination and leaves source mode intact", async (t) => {
  const f = fixture(t)
  const dest = await f.destination()
  const controller = new AbortController()
  let cleaned = 0
  t.mock.method(dest, "prepareTransferLocked", async () => { controller.abort() })
  t.mock.method(dest, "releaseSession", async () => { cleaned++ })
  await assert.rejects(f.router.setMode("a", "isolated", controller.signal))
  assert.equal(cleaned, 1)
  assert.equal((await f.router.inspectPages("a")).mode, "shared")
})

test("destination loss rolls back to intact source without replay, retrying uncertain writes and cleanup", async (t) => {
  const f = fixture(t)
  const dest = await f.destination()
  const pages = [{ pageId: "stable", url: "https://example.test/", title: "" }]
  t.mock.method(f.router.shared, "inspectTransfer", async () => ({ visibility: "headless" as const, paused: false, pages }))
  let prepares = 0, releases = 0, cleanups = 0, writeFails = true, cleanupFails = true
  t.mock.method(dest, "prepareTransferLocked", async () => { prepares++ })
  t.mock.method(f.router.shared, "releaseSession", async () => { releases++ })
  t.mock.method(dest, "releaseSession", async () => { cleanups++; if (cleanupFails) throw new Error("cleanup failed") })
  const set = f.store.set.bind(f.store)
  t.mock.method(f.store, "set", async (key: string, value: string) => {
    if (value === "shared" && writeFails) throw new Error("rollback write failed")
    await set(key, value)
    if (value === "shared") throw new Error("rollback response lost")
  })
  // The destination has no surviving tabs when persistence finishes.
  await assert.rejects(f.router.setMode("a", "isolated"), /switch incomplete/)
  await assert.rejects(f.router.inspectPages("a"), /Could not confirm restored source mode/)
  ;(f.router.shared as any).leases.set("a", { touched: 0 })
  await f.router.shared.sweep()
  assert.equal(releases, 0)
  assert.equal(prepares, 1)
  assert.equal(f.registry.transfers.has(f.key("a")), true)
  writeFails = false
  await assert.rejects(f.router.inspectPages("a"), /cleanup failed/)
  assert.equal(f.values.get(f.modeKey("a")), "shared")
  cleanupFails = false
  assert.equal((await f.router.inspectPages("a")).mode, "shared")
  assert.equal(cleanups, 2)
  assert.equal(releases, 0)
  assert.equal(prepares, 1)
  assert.equal(f.registry.transfers.has(f.key("a")), false)
})

test("unverifiable destination or partially lost source never causes destructive rollback", async (t) => {
  const f = fixture(t)
  const dest = await f.destination()
  const pages = [{ pageId: "stable", url: "https://example.test/", title: "" }]
  let intact = true, transient = true, cleanups = 0
  t.mock.method(f.router.shared, "inspectTransfer", async () => ({ visibility: "headless" as const, paused: false, pages: intact ? pages : [] }))
  t.mock.method(dest, "prepareTransferLocked", async () => {})
  t.mock.method(dest, "inspectTransfer", async () => {
    if (transient) throw new Error("metadata unavailable")
    return { visibility: "headless" as const, paused: false, pages: [] }
  })
  t.mock.method(dest, "releaseSession", async () => { cleanups++ })
  await assert.rejects(f.router.setMode("a", "isolated"), /switch incomplete/)
  await assert.rejects(f.router.inspectPages("a"), /metadata unavailable/)
  transient = false
  intact = false
  await assert.rejects(f.router.inspectPages("a"), /cannot be verified/)
  assert.equal(f.values.get(f.modeKey("a")), "isolated")
  assert.equal(cleanups, 0)
  intact = true
  assert.equal((await f.router.inspectPages("a")).mode, "shared")
  assert.equal(cleanups, 1)
})

test("both lifecycle queues remain locked across persistence in either transfer direction", async (t) => {
  const f = fixture(t)
  const dest = await f.destination("a", false)
  dest.evictWhenIdle = false
  for (const mode of ["shared", "isolated"] as const) {
    let entered!: () => void, unblock!: () => void
    const ready = new Promise<void>((resolve) => { entered = resolve })
    const gate = new Promise<void>((resolve) => { unblock = resolve })
    const set = f.store.set.bind(f.store)
    const mock = t.mock.method(f.store, "set", async (key: string, value: string) => { entered(); await gate; await set(key, value) })
    const change = f.router.setMode("a", mode)
    try {
      await ready
      let sharedDone = false, isolatedDone = false
      const shared = f.router.shared.execute("set_visibility", { visibility: "headed" }, { sessionID: "b", directory: f.root }).then(() => { sharedDone = true })
      const isolated = dest.sweep().then(() => { isolatedDone = true })
      await new Promise((resolve) => setImmediate(resolve))
      assert.equal(sharedDone, false)
      assert.equal(isolatedDone, false)
      unblock()
      await Promise.all([change, shared, isolated])
    } finally { unblock(); mock.mock.restore() }
  }
})

test("empty transfer cannot enter a shared browser paused for login or recovery", async (t) => {
  const f = fixture(t)
  await f.router.setMode("a", "isolated")
  for (const state of ["login", "restoration"] as const) {
    ;(f.router.shared as any)[state] = state === "login" ? { sessionID: "b", deadline: Infinity } : []
    await assert.rejects(f.router.setMode("a", "shared"), /Destination browser is paused/)
    ;(f.router.shared as any)[state] = undefined
    assert.equal((await f.router.inspectPages("a")).mode, "isolated")
  }
})

test("attach mode login never launches or restarts Chrome and visibility is unavailable", async (t) => {
  const f = fixture(t)
  await f.router.setMode("a", "attach")
  const caller = { sessionID: "a", directory: f.root }
  assert.match((await f.router.execute("login_start", { pageId: "anything" }, caller)).content, /log in manually/)
  assert.match((await f.router.execute("login_finish", {}, caller)).content, /not restarted/)
  await assert.rejects(f.router.execute("set_visibility", { visibility: "headed" }, caller), /controlled by the user/)
  const state = await f.router.inspectPages("a")
  assert.equal(state.mode, "attach")
  assert.equal(state.visibility, null)
  assert.deepEqual(state.pages, [])
})

test("switching mode or visibility while stopped never launches or connects to Chrome", async (t) => {
  const f = fixture(t)
  const start = t.mock.method(Chrome.prototype, "start", async () => { throw new Error("Unexpected Chrome launch") })
  const attach = t.mock.method(AttachChrome.prototype, "start", async () => { throw new Error("Unexpected Chrome attachment") })
  const caller = { sessionID: "a", directory: f.root }
  for (const mode of ["shared", "isolated", "attach", "shared"] as const) {
    await f.router.setMode("a", mode)
    const snapshot = await f.router.inspectPages("a")
    assert.equal(snapshot.mode, mode)
    assert.deepEqual(snapshot.pages, [])
    if (mode === "attach") continue
    await f.router.execute("set_visibility", { visibility: "headed" }, caller)
    for (const manager of f.managers) await manager.sweep()
    assert.equal((await f.router.inspectPages("a")).visibility, "headed", "idle cleanup must preserve the selection for the next launch")
    const status = JSON.parse((await f.router.execute("status", {}, caller)).content as string)
    assert.equal(status.running, false)
    assert.equal(status.activeLeases, 0)
    await f.router.execute("set_visibility", { visibility: "headless" }, caller)
    assert.equal((await f.router.inspectPages("a")).visibility, "headless")
  }
  assert.equal(start.mock.callCount(), 0)
  assert.equal(attach.mock.callCount(), 0)
})

test("attach mode fails clearly without a debugging endpoint and never launches a fallback", async (t) => {
  const f = fixture(t)
  const chrome = new AttachChrome(join(f.root, "missing-chrome-profile"))
  t.after(() => chrome.stop())
  await assert.rejects(chrome.start(true), /Enable remote debugging.*No other browser will be launched/)
})

test("user Chrome endpoint checks require a valid different endpoint", async (t) => {
  const f = fixture(t)
  const chrome = new AttachChrome(f.root)
  t.after(() => chrome.stop())
  const browser = { url: "ws://127.0.0.1:1234/devtools/browser/old" } as any
  await mkdir(f.root, { recursive: true })
  assert.equal(await chrome.current(browser), true)
  await writeFile(join(f.root, "DevToolsActivePort"), "partial")
  assert.equal(await chrome.current(browser), true)
  await writeFile(join(f.root, "DevToolsActivePort"), "1234\n/devtools/browser/old\n")
  assert.equal(await chrome.current(browser), true)
  await writeFile(join(f.root, "DevToolsActivePort"), "1234\n/devtools/browser/new\n")
  assert.equal(await chrome.current(browser), false)
})

test("session deletion removes only its retained isolated profile and mode", async (t) => {
  const f = fixture(t)
  const { profile } = f
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
})

test("session deletion continues after shared release fails and can be retried", async (t) => {
  const f = fixture(t)
  const profile = f.profile("a")
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
})

test("persisted deletion is recovered after router restart", async (t) => {
  const f = fixture(t)
  await f.router.setMode("a", "isolated")
  t.mock.method(f.router.shared, "release", async () => { throw new Error("unavailable") })
  await assert.rejects(f.router.delete("a"), /unavailable/)
  t.mock.restoreAll()
  f.router.detach()
  const second = f.createRouter()
  await second.recoverDeletions()
  for (let i = 0; i < 100 && f.values.size; i++) await new Promise((resolve) => setTimeout(resolve, 10))
  assert.equal(f.values.size, 0)
})

test("live cleanup retries a transient failure", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] })
  const f = fixture(t)
  // Profile removal has separate filesystem coverage; keep this scheduling test deterministic.
  t.mock.method(Chrome.prototype, "removeProfile", async () => {})
  const release = f.router.shared.release.bind(f.router.shared)
  let attempts = 0
  t.mock.method(console, "error", () => {})
  t.mock.method(f.router.shared, "release", async (id: string) => {
    if (++attempts === 1) throw new Error("temporary")
    await release(id)
  })
  await f.router.scheduleDeletion("a")
  t.mock.timers.tick(0)
  await flushAsync()
  assert.equal(attempts, 1)
  assert.equal(f.values.size, 1, "failed cleanup retains its durable tombstone")
  t.mock.timers.tick(4_999)
  await flushAsync()
  assert.equal(attempts, 1, "cleanup must wait for the retry backoff")
  t.mock.timers.tick(1)
  await flushAsync()
  assert.equal(attempts, 2)
  assert.equal(f.values.size, 0)
  t.mock.timers.tick(5_000)
  await flushAsync()
  assert.equal(attempts, 2, "successful cleanup must stop retrying")
})

test("idle isolated manager is evicted across routers and can be recreated", async (t) => {
  const f = fixture(t)
  const second = f.createRouter()
  const profile = f.profile("a")
  const old = await f.destination("a", false)
  await f.router.inspectPages("a")
  await second.inspectPages("a")
  await old.sweep()
  assert.equal(old.isRetired, true)
  assert.equal(f.registry.managers.has(profile), false)
  await second.inspectPages("a")
  assert.notEqual(f.registry.managers.get(profile), old)
})

test("profile removal holds an external lock against another service", async (t) => {
  const f = fixture(t)
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
  } finally { unblock() }
})

test("per-session queues are discarded after all queued operations finish", async (t) => {
  const f = fixture(t)
  const key = f.key("queue-test")
  await Promise.all([f.router.inspectPages("queue-test"), f.router.inspectPages("queue-test")])
  // Queue bookkeeping runs after the last operation settles.
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(f.registry.queues.has(key), false)
})
