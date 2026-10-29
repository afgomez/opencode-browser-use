import { createHash } from "node:crypto"
import { join } from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { BrowserManager, sharedManager, type Caller } from "./manager"
import type { Options } from "./options"
import { Serial } from "./serial"
import { AttachChrome } from "./attach-chrome"
import { Chrome } from "./chrome"
import { connectMcp } from "./mcp"

export type BrowserMode = "shared" | "isolated" | "attach"
export function browserMode(value: unknown): BrowserMode {
  if (value === "shared" || value === "isolated" || value === "attach") return value
  throw new Error("Browser mode must be shared, isolated, or attach")
}
type Storage = { get(key: string): Promise<unknown>; set(key: string, value: string): Promise<void>; remove(key: string): Promise<void>; scan?(options: { prefix: string; after?: string; limit?: number }): Promise<{ entries: readonly { key: string; value: unknown }[]; next?: string }> }
type Registry = { queues: Map<string, Serial>; managers: Map<string, BrowserManager> }
const symbol = Symbol.for("opencode.browser-use.router.v1")
const root = globalThis as typeof globalThis & { [symbol]?: Registry }
const registry = root[symbol] ??= { queues: new Map(), managers: new Map() }
const hash = (value: string) => createHash("sha256").update(value).digest("hex")

/** Routes by persisted session choice. The per-session queue serializes switches with tools. */
export class BrowserRouter {
  private attached = new Map<BrowserManager, () => void>()
  private retries = new Map<string, NodeJS.Timeout>()
  private detached = false
  readonly shared: BrowserManager
  constructor(private config: Options, private storage: Storage) {
    this.shared = sharedManager(config)
    this.attach(this.shared)
  }
  private attach(manager: BrowserManager) {
    if (!this.attached.has(manager)) this.attached.set(manager, manager.attach(() => {
      this.attached.delete(manager)
      for (const [key, value] of registry.managers) if (value === manager) registry.managers.delete(key)
    }))
    return manager
  }
  private key(sessionID: string) { return `browser-mode.${hash(sessionID)}` }
  private deletionKey(sessionID: string) { return `browser-deletion.${hash(sessionID)}` }
  private profile(sessionID: string) { return join(`${this.config.profileDirectory}-isolated`, hash(sessionID)) }
  private queue(sessionID: string) {
    const key = `${this.config.profileDirectory}:${sessionID}`
    let queue = registry.queues.get(key)
    if (!queue) {
      queue = new Serial(() => { if (registry.queues.get(key) === queue) registry.queues.delete(key) })
      registry.queues.set(key, queue)
    }
    return queue
  }
  private async mode(sessionID: string): Promise<BrowserMode> {
    if (await this.storage.get(this.deletionKey(sessionID)) !== undefined) throw new Error("Browser session deletion is pending cleanup")
    const value = await this.storage.get(this.key(sessionID))
    return value === undefined ? "shared" : value === "user" ? "attach" : browserMode(value)
  }
  private manager(mode: BrowserMode, sessionID: string) {
    if (mode === "shared") return this.shared
    // Keep the legacy registry key so hot reloads retain existing attached tabs.
    const key = mode === "attach" ? `${this.config.profileDirectory}:user` : this.profile(sessionID)
    let manager = registry.managers.get(key)
    if (!manager || manager.isRetired) {
      manager = mode === "attach"
        ? new BrowserManager(this.config, { chrome: new AttachChrome() })
        : new BrowserManager({ ...this.config, profileDirectory: this.profile(sessionID) })
      manager.evictWhenIdle = mode === "isolated"
      registry.managers.set(key, manager)
    } else BrowserManager.upgrade(manager, connectMcp)
    return this.attach(manager)
  }
  async execute(name: string, input: Record<string, unknown>, caller: Caller) {
    return this.queue(caller.sessionID).run(async () => {
      const mode = await this.mode(caller.sessionID)
      if (mode === "attach" && (name === "login_start" || name === "login_finish")) {
        return { content: "User Chrome is not restarted or paused. Ask the user to log in manually in their Chrome, then continue after they confirm." }
      }
      if (mode === "attach" && name === "set_visibility") throw new Error("Visibility is controlled by the user in their own Chrome")
      let result
      try { result = await this.manager(mode, caller.sessionID).execute(name, input, caller) } catch (error) {
        if (mode === "attach" && /connect|websocket|debugging|Chrome MCP tool failed/i.test(String(error))) {
          throw new Error("User Chrome request failed. Make sure chrome://inspect/#remote-debugging is enabled and approve all connection requests. No other browser will be launched.", { cause: error })
        }
        throw error
      }
      if (name === "status") {
        const value = JSON.parse(result.content as string)
        return { ...result, content: JSON.stringify({ ...value, mode, ...(mode === "attach" ? { visibility: null } : {}) }) }
      }
      return result
    }, caller.signal)
  }
  async inspectPages(sessionID: string, signal?: AbortSignal) {
    return this.queue(sessionID).run(async () => {
      const mode = await this.mode(sessionID)
      const snapshot = await this.manager(mode, sessionID).inspectPages(sessionID, signal)
      return { ...snapshot, mode, visibility: mode === "attach" ? null : snapshot.visibility }
    }, signal)
  }
  async setMode(sessionID: string, value: unknown, signal?: AbortSignal) {
    return this.queue(sessionID).run(async () => {
      const mode = browserMode(value)
      const old = await this.mode(sessionID)
      if (mode === old) return
      const manager = this.manager(old, sessionID)
      const state = await manager.inspectPages(sessionID, signal)
      if (state.paused) throw new Error("Finish the browser login or recovery before switching mode")
      await manager.release(sessionID)
      await this.storage.set(this.key(sessionID), mode)
    }, signal)
  }
  async delete(sessionID: string) {
    return this.queue(sessionID).run(async () => {
      // Persist before cleanup. The mode and tombstone survive partial failure.
      await this.storage.set(this.deletionKey(sessionID), sessionID)
      // Release all managers, even if an earlier switch was interrupted.
      const errors: unknown[] = []
      const attempt = async (work: () => Promise<void>) => { try { await work() } catch (error) { errors.push(error) } }
      await attempt(() => this.shared.release(sessionID))
      const isolated = registry.managers.get(this.profile(sessionID))
      const attached = registry.managers.get(`${this.config.profileDirectory}:user`)
      let isolatedStopped = !isolated
      if (attached) await attempt(() => attached.release(sessionID))
      if (isolated) {
        await attempt(async () => {
          await isolated.release(sessionID)
          await isolated.dispose()
          isolatedStopped = true
          this.attached.get(isolated)?.()
          this.attached.delete(isolated)
          if (registry.managers.get(this.profile(sessionID)) === isolated) registry.managers.delete(this.profile(sessionID))
        })
      }
      // A crashed service's profile lock may take 30 seconds to become stale.
      // Never delete the directory without first acquiring its lock and stopping
      // a verified survivor, even when the session was not used after restart.
      // Do not remove a profile if its in-process manager could not be stopped.
      if (isolatedStopped) await attempt(async () => {
        const chrome = new Chrome({ ...this.config, profileDirectory: this.profile(sessionID) })
        for (let retries = 0; ; retries++) {
          try { await chrome.removeProfile(); break } catch (error) {
            if (retries >= 35 || !(error instanceof Error) || !error.message.includes("managed by another OpenCode service")) throw error
            await delay(1_000)
          }
        }
      })
      if (errors.length === 1) throw errors[0]
      if (errors.length) throw new AggregateError(errors, "Browser session cleanup was incomplete; retry deletion")
      await this.storage.remove(this.key(sessionID))
      await this.storage.remove(this.deletionKey(sessionID))
    })
  }

  /** Retry persisted tombstones both live and after the plugin is restarted. */
  async scheduleDeletion(sessionID: string) {
    if (this.detached || this.retries.has(sessionID)) return
    // Await durable recording before consuming another event or returning.
    try { await this.storage.set(this.deletionKey(sessionID), sessionID) } catch (error) {
      if (!this.detached && !this.retries.has(sessionID)) {
        const timer = setTimeout(() => {
          this.retries.delete(sessionID)
          void this.scheduleDeletion(sessionID).catch((error) => console.error("[browser-use] Could not persist session cleanup", error))
        }, 5_000)
        timer.unref()
        this.retries.set(sessionID, timer)
      }
      throw error
    }
    if (this.detached || this.retries.has(sessionID)) return
    // Reserve the slot while cleanup is in flight, as well as while waiting.
    const run = async () => {
      try { await this.delete(sessionID); this.retries.delete(sessionID) } catch (error) {
        if (this.detached) { this.retries.delete(sessionID); return }
        console.error("[browser-use] Session cleanup failed", error)
        const timer = setTimeout(run, 5_000)
        timer.unref()
        this.retries.set(sessionID, timer)
      }
    }
    const timer = setTimeout(run, 0)
    timer.unref()
    this.retries.set(sessionID, timer)
  }

  async recoverDeletions() {
    if (!this.storage.scan) return
    let after: string | undefined
    do {
      const page = await this.storage.scan({ prefix: "browser-deletion.", after, limit: 100 })
      for (const entry of page.entries) if (typeof entry.value === "string" && entry.key === this.deletionKey(entry.value)) await this.scheduleDeletion(entry.value)
      after = page.next
    } while (after && !this.detached)
  }
  detach() {
    this.detached = true
    for (const timer of this.retries.values()) clearTimeout(timer)
    this.retries.clear()
    for (const detach of this.attached.values()) detach(); this.attached.clear()
  }
}
