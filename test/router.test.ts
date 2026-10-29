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
  } finally { f.router.detach(); await f.router.shared.dispose(); await rm(f.root, { recursive: true, force: true }) }
})

test("switch recovery retains source on preparation failure and resolves uncertain persistence without replay", async (t) => {
  const f = fixture()
  const registry = (globalThis as any)[Symbol.for("opencode.browser-use.router.v1")]
  const profile = join(`${f.config.profileDirectory}-isolated`, createHash("sha256").update("a").digest("hex"))
  try {
    // Construct the destination lazily without launching Chrome.
    await f.router.setMode("a", "isolated")
    await f.router.setMode("a", "shared")
    const destination = registry.managers.get(profile)
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
  } finally { t.mock.restoreAll(); f.router.detach(); await f.router.shared.dispose(); const dest = registry.managers.get(profile); await dest?.dispose(); await rm(f.root, { recursive: true, force: true }) }
})

test("partial source cleanup blocks operations until retried, without repeating preparation", async (t) => {
  const f = fixture()
  const registry = (globalThis as any)[Symbol.for("opencode.browser-use.router.v1")]
  const profile = join(`${f.config.profileDirectory}-isolated`, createHash("sha256").update("a").digest("hex"))
  try {
    await f.router.setMode("a", "isolated")
    await f.router.setMode("a", "shared")
    const dest = registry.managers.get(profile)
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
    assert.equal(registry.transfers.has(`${f.config.profileDirectory}:a`), false)
  } finally { t.mock.restoreAll(); f.router.detach(); await f.router.shared.dispose(); await registry.managers.get(profile)?.dispose(); await rm(f.root, { recursive: true, force: true }) }
})

test("cancelled preparation cleans destination and leaves source mode intact", async (t) => {
  const f = fixture()
  const registry = (globalThis as any)[Symbol.for("opencode.browser-use.router.v1")]
  const profile = join(`${f.config.profileDirectory}-isolated`, createHash("sha256").update("a").digest("hex"))
  try {
    await f.router.setMode("a", "isolated")
    await f.router.setMode("a", "shared")
    const dest = registry.managers.get(profile)
    const controller = new AbortController()
    let cleaned = 0
    t.mock.method(dest, "prepareTransferLocked", async () => { controller.abort() })
    t.mock.method(dest, "releaseSession", async () => { cleaned++ })
    await assert.rejects(f.router.setMode("a", "isolated", controller.signal))
    assert.equal(cleaned, 1)
    assert.equal((await f.router.inspectPages("a")).mode, "shared")
  } finally { t.mock.restoreAll(); f.router.detach(); await f.router.shared.dispose(); await registry.managers.get(profile)?.dispose(); await rm(f.root, { recursive: true, force: true }) }
})

test("destination loss rolls back to intact source without replay, retrying uncertain writes and cleanup", async (t) => {
  const f = fixture()
  const registry = (globalThis as any)[Symbol.for("opencode.browser-use.router.v1")]
  const profile = join(`${f.config.profileDirectory}-isolated`, createHash("sha256").update("a").digest("hex"))
  try {
    await f.router.setMode("a", "isolated")
    await f.router.setMode("a", "shared")
    const dest = registry.managers.get(profile)
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
    assert.equal(registry.transfers.has(`${f.config.profileDirectory}:a`), true)
    writeFails = false
    await assert.rejects(f.router.inspectPages("a"), /cleanup failed/)
    assert.equal(f.values.get(`browser-mode.${createHash("sha256").update("a").digest("hex")}`), "shared")
    cleanupFails = false
    assert.equal((await f.router.inspectPages("a")).mode, "shared")
    assert.equal(cleanups, 2)
    assert.equal(releases, 0)
    assert.equal(prepares, 1)
    assert.equal(registry.transfers.has(`${f.config.profileDirectory}:a`), false)
  } finally { t.mock.restoreAll(); f.router.detach(); await f.router.shared.dispose(); await registry.managers.get(profile)?.dispose(); registry.transfers.delete(`${f.config.profileDirectory}:a`); await rm(f.root, { recursive: true, force: true }) }
})

test("unverifiable destination or partially lost source never causes destructive rollback", async (t) => {
  const f = fixture()
  const registry = (globalThis as any)[Symbol.for("opencode.browser-use.router.v1")]
  const profile = join(`${f.config.profileDirectory}-isolated`, createHash("sha256").update("a").digest("hex"))
  try {
    await f.router.setMode("a", "isolated")
    await f.router.setMode("a", "shared")
    const dest = registry.managers.get(profile)
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
    assert.equal(f.values.get(`browser-mode.${createHash("sha256").update("a").digest("hex")}`), "isolated")
    assert.equal(cleanups, 0)
    intact = true
    assert.equal((await f.router.inspectPages("a")).mode, "shared")
    assert.equal(cleanups, 1)
  } finally { t.mock.restoreAll(); f.router.detach(); await f.router.shared.dispose(); await registry.managers.get(profile)?.dispose(); registry.transfers.delete(`${f.config.profileDirectory}:a`); await rm(f.root, { recursive: true, force: true }) }
})

test("both lifecycle queues remain locked across persistence in either transfer direction", async (t) => {
  const f = fixture()
  const registry = (globalThis as any)[Symbol.for("opencode.browser-use.router.v1")]
  const profile = join(`${f.config.profileDirectory}-isolated`, createHash("sha256").update("a").digest("hex"))
  try {
    await f.router.setMode("a", "isolated")
    const dest = registry.managers.get(profile)
    dest.evictWhenIdle = false
    for (const mode of ["shared", "isolated"] as const) {
      let entered!: () => void, unblock!: () => void
      const ready = new Promise<void>((resolve) => { entered = resolve })
      const gate = new Promise<void>((resolve) => { unblock = resolve })
      const set = f.store.set.bind(f.store)
      const mock = t.mock.method(f.store, "set", async (key: string, value: string) => { entered(); await gate; await set(key, value) })
      const change = f.router.setMode("a", mode)
      await ready
      let sharedDone = false, isolatedDone = false
      const shared = f.router.shared.execute("set_visibility", { visibility: "headed" }, { sessionID: "b", directory: f.root }).then(() => { sharedDone = true })
      const isolated = dest.sweep().then(() => { isolatedDone = true })
      await new Promise((resolve) => setImmediate(resolve))
      assert.equal(sharedDone, false)
      assert.equal(isolatedDone, false)
      unblock()
      await Promise.all([change, shared, isolated])
      mock.mock.restore()
    }
  } finally { t.mock.restoreAll(); f.router.detach(); await f.router.shared.dispose(); await registry.managers.get(profile)?.dispose(); await rm(f.root, { recursive: true, force: true }) }
})

test("empty transfer cannot enter a shared browser paused for login or recovery", async () => {
  const f = fixture()
  const registry = (globalThis as any)[Symbol.for("opencode.browser-use.router.v1")]
  const profile = join(`${f.config.profileDirectory}-isolated`, createHash("sha256").update("a").digest("hex"))
  try {
    await f.router.setMode("a", "isolated")
    for (const state of ["login", "restoration"] as const) {
      ;(f.router.shared as any)[state] = state === "login" ? { sessionID: "b", deadline: Infinity } : []
      await assert.rejects(f.router.setMode("a", "shared"), /Destination browser is paused/)
      ;(f.router.shared as any)[state] = undefined
      assert.equal((await f.router.inspectPages("a")).mode, "isolated")
    }
  } finally { (f.router.shared as any).login = undefined; (f.router.shared as any).restoration = undefined; f.router.detach(); await f.router.shared.dispose(); await registry.managers.get(profile)?.dispose(); await rm(f.root, { recursive: true, force: true }) }
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
