import { randomUUID } from "node:crypto"
import { isAbsolute, resolve } from "node:path"
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js"
import { Chrome, type BrowserProcess } from "./chrome"
import { connectMcp, type Mcp } from "./mcp"
import type { Options } from "./options"
import { browserVisibility, data, filteredResult, pageTools, type BrowserVisibility, type PublicPage } from "./policy"
import { Serial } from "./serial"
import type { PagesSnapshot } from "./rpc"
import { Cdp } from "./cdp"

export interface Caller { sessionID: string; directory: string; signal?: AbortSignal }
interface Page extends PublicPage { sessionID: string; tabId: string; upstreamId: number }
interface Lease { touched: number }
interface Login { sessionID: string; deadline: number }
interface RawPage { id: number; url: string; title: string }
interface Dependencies {
  chrome: Pick<Chrome, "start" | "stop"> & { current?(browser: BrowserProcess): Promise<boolean> }
  connect: typeof connectMcp
  now: () => number
}

export class BrowserManager {
  private serial = new Serial()
  private pages = new Map<string, Page>()
  private pendingPages = new Map<string, string>()
  private leases = new Map<string, Lease>()
  private browser?: BrowserProcess
  private mcp?: Mcp
  private login?: Login
  private references = new Set<symbol>()
  private unreferencedAt?: number
  private idleAt?: number
  private timer?: NodeJS.Timeout
  private dependencies: Dependencies
  private maintenanceError?: string
  private restoration?: Page[]
  private visibility: BrowserVisibility = "headless"
  private retired = false
  private retiredListeners = new Set<() => void>()
  evictWhenIdle = false

  get isRetired() { return this.retired }

  constructor(readonly config: Options, dependencies?: Partial<Dependencies>) {
    this.dependencies = { chrome: new Chrome(config), connect: connectMcp, now: Date.now, ...dependencies }
  }

  attach(onRetired?: () => void): () => void {
    this.assertActive()
    const reference = Symbol()
    this.references.add(reference)
    if (onRetired) this.retiredListeners.add(onRetired)
    this.unreferencedAt = undefined
    if (!this.timer) {
      this.timer = setInterval(() => {
        void this.sweep().catch((error) => { this.maintenanceError = String(error) })
      }, Math.min(15_000, this.config.idleTimeoutMs, this.config.unloadGraceMs))
      this.timer.unref()
    }
    return () => {
      this.references.delete(reference)
      if (onRetired) this.retiredListeners.delete(onRetired)
      if (!this.references.size) this.unreferencedAt = this.dependencies.now()
    }
  }

  async execute(name: string, input: Record<string, unknown>, caller: Caller) {
    if (!caller.sessionID) throw new Error("Browser tools require a trusted OpenCode session ID")
    return this.serial.run(async () => {
      if (name === "status") { await this.invalidateDeadBrowser(); return this.status(caller.sessionID) }
      if (name === "release") {
        await this.releaseSession(caller.sessionID)
        return { content: "Released this session's browser lease and closed its tabs." }
      }
      this.assertActive()
      if (name === "login_finish") {
        if (!this.login || this.login.sessionID !== caller.sessionID) throw new Error("Only the session that started login can finish it")
        await this.transition(true)
        this.login = undefined
        this.touch(caller.sessionID)
        return { content: "Headless operation resumed. Cookies persist; pages were reloaded. Take fresh snapshots." }
      }
      if (this.login) throw new Error("Browser automation is paused for human login. The initiating session must call browser_use_login_finish.")
      if (name === "set_visibility") {
        const visibility = browserVisibility(input.visibility)
        await this.invalidateDeadBrowser()
        // Configure the next launch without creating a browser or a lease. A
        // failed restoration is different: explicit retries must still recover it.
        if (!this.browser && !this.restoration) {
          const changed = visibility !== this.visibility
          this.visibility = visibility
          return { content: JSON.stringify({ visibility, changed, running: false, pages: [] }) }
        }
        if (visibility === this.visibility && !this.restoration) {
          this.touch(caller.sessionID)
          return { content: JSON.stringify({ visibility, changed: false, running: !!this.browser, pages: this.publicPages(caller.sessionID) }) }
        }
        this.touch(caller.sessionID)
        await this.transition(visibility === "headless")
        if (visibility === "headed") {
          // Show only the requesting session's tab, never another session's tab.
          const page = [...this.pages.values()].find((page) => page.sessionID === caller.sessionID)
          if (page) await this.browser!.cdp.send("Target.activateTarget", { targetId: page.tabId })
        }
        return { content: JSON.stringify({
          visibility, changed: true, running: true, paused: false,
          message: "Browser automation remains enabled. All owned tabs were reloaded; take fresh snapshots.",
          pages: this.publicPages(caller.sessionID),
        }) }
      }
      if (this.restoration) throw new Error("A browser visibility transition failed; automation is paused. Use /browser-use visibility headed or /browser-use visibility headless to finish restoring tabs.")
      this.touch(caller.sessionID)
      await this.ensure()
      await this.mcp!.roots(caller.directory)
      if (name === "login_start") {
        const page = this.owned(input.pageId, caller.sessionID)
        await this.refresh()
        if (!this.pages.has(page.pageId)) throw new Error("This page has closed")
        this.login = { sessionID: caller.sessionID, deadline: this.dependencies.now() + this.config.loginTimeoutMs }
        try {
          await this.transition(false)
          // Focus only at the explicit human handoff, never ordinary automation.
          const restored = this.owned(page.pageId, caller.sessionID)
          await this.browser!.cdp.send("Target.activateTarget", { targetId: restored.tabId })
        } catch (error) {
          // Remain paused: a failed transition must not silently enable automation
          // in a partly restored headed browser. login_finish can retry recovery.
          throw error
        }
        return { content: "Chrome is open for human login; all browser automation is paused. When finished, call browser_use_login_finish. Tabs were reloaded; snapshots are stale." }
      }
      if (name === "new_page") {
        if (typeof input.url !== "string") throw new Error("url is required")
        const page = await this.createPage(caller.sessionID)
        const result = await this.call("navigate_page", {
          pageId: page.upstreamId, url: input.url, ...(input.timeout === undefined ? {} : { timeout: input.timeout }),
        }, caller.signal)
        await this.refresh()
        if (!this.pages.has(page.pageId)) return { content: "The newly opened tab closed. Call browser_use_list_pages." }
        return filteredResult(result, this.publicPages(caller.sessionID))
      }
      if (name === "list_pages") {
        await this.refresh()
        return { content: JSON.stringify({ pages: this.publicPages(caller.sessionID) }) }
      }
      // Reject before any target lookup or page operation. Identity never comes
      // from model-supplied input, and raw upstream numeric IDs are not accepted.
      let page = this.owned(input.pageId, caller.sessionID)
      if (!(pageTools.has(name) || name === "close_page" || name === "select_page")) throw new Error("Unsupported browser operation")
      if ("serviceWorkerId" in input) throw new Error("Service-worker access is not session scoped and is disabled")
      if (input.bringToFront === true) throw new Error("Use browser_use_login_start for an explicit headed handoff")
      await this.refresh()
      page = this.owned(page.pageId, caller.sessionID)
      if (name === "close_page") {
        await this.closeTab(page)
        this.pages.delete(page.pageId)
        return { content: JSON.stringify({ pages: this.publicPages(caller.sessionID) }) }
      }
      // There is deliberately no shared selected-page state in our API.
      if (name === "select_page") return { content: JSON.stringify(pageView(page)) }
      const args: Record<string, unknown> = { ...input, pageId: page.upstreamId }
      for (const key of ["filePath", "sourcePath", "requestFilePath", "responseFilePath"]) {
        if (typeof args[key] === "string" && !isAbsolute(args[key])) args[key] = resolve(caller.directory, args[key])
      }
      if (Array.isArray(args.filePaths)) args.filePaths = args.filePaths.map((path: string) => resolve(caller.directory, path))
      const result = await this.call(name, args, caller.signal)
      // Update ownership metadata, but never adopt unknown human/popup tabs.
      await this.refresh()
      if (!this.pages.has(page.pageId)) return { content: "The target tab closed during this operation. Call browser_use_list_pages." }
      return filteredResult(result, this.publicPages(caller.sessionID))
    }, caller.signal)
  }

  private touch(sessionID: string) {
    this.leases.set(sessionID, { touched: this.dependencies.now() })
    this.idleAt = undefined
  }

  private assertActive() {
    if (this.retired) throw new Error("Browser manager was unloaded; reload the plugin before continuing")
  }

  private owned(id: unknown, sessionID: string): Page {
    const page = typeof id === "string" ? this.pages.get(id) : undefined
    if (!page || page.sessionID !== sessionID) throw new Error("Unknown, closed, or foreign page handle. Call browser_use_list_pages or browser_use_new_page.")
    return page
  }

  private publicPages(sessionID: string): PublicPage[] {
    return [...this.pages.values()].filter((page) => page.sessionID === sessionID).map(pageView)
  }

  /** Passive UI inspection: never launch/restart Chrome, touch leases, or select a page. */
  async inspectPages(sessionID: string, signal?: AbortSignal): Promise<PagesSnapshot> {
    if (!sessionID) throw new Error("Browser inspection requires a session ID")
    return this.serial.run(async () => {
      this.assertActive()
      await this.invalidateDeadBrowser()
      const state = { visibility: this.visibility, paused: !!this.login || !!this.restoration }
      if (!this.browser?.alive()) return { ...state, pages: [] }
      const owned = [...this.pages.values()].filter((page) => page.sessionID === sessionID)
      if (!owned.length) return { ...state, pages: [] }
      // Browser-level metadata also catches human navigation/title changes and
      // tab closure during login. No page scripts or paused automation are run.
      // get_tab_id identifies the tab target, not its inner page target. Chrome
      // excludes tab targets by default, so request them explicitly.
      const browser = this.browser
      if (Cdp.disconnected(browser.cdp)) await Cdp.reconnect(browser.cdp)
      const read = () => browser.cdp.send<{
        targetInfos: Array<{ targetId: string; type: string; title: string; url: string }>
      }>("Target.getTargets", { filter: [{ type: "tab" }] })
      let result: Awaited<ReturnType<typeof read>>
      try { result = await read() } catch (error) {
        // Repair only the existing metadata transport while exclusive profile
        // ownership is still valid. Never launch Chrome or retry a page action.
        if (!browser.alive() || !Cdp.disconnected(browser.cdp)) throw error
        await Cdp.reconnect(browser.cdp)
        result = await read()
      }
      const { targetInfos } = result
      const targets = new Map(targetInfos.filter((target) => target.type === "tab").map((target) => [target.targetId, target]))
      const pages: PublicPage[] = []
      for (const page of owned) {
        const target = targets.get(page.tabId)
        if (!target) continue
        pages.push({ pageId: page.pageId, title: target.title, url: target.url })
      }
      return { ...state, pages }
    }, signal)
  }

  private status(sessionID: string) {
    return { content: JSON.stringify({
      running: this.browser?.alive() ?? false,
      visibility: this.visibility,
      paused: !!this.login || !!this.restoration,
      loginOwnedByThisSession: this.login?.sessionID === sessionID,
      leaseHeld: this.leases.has(sessionID),
      activeLeases: this.leases.size,
      pages: this.publicPages(sessionID),
      ...(this.maintenanceError ? { maintenanceError: this.maintenanceError } : {}),
    }) }
  }

  private async ensure() {
    await this.invalidateDeadBrowser()
    if (!this.browser) this.browser = await this.dependencies.chrome.start(this.visibility === "headless")
    if (Cdp.disconnected(this.browser.cdp)) await Cdp.reconnect(this.browser.cdp)
    await this.cleanupPending()
    if (!this.mcp) this.mcp = await this.dependencies.connect(this.config.nodePath, this.browser.url)
  }

  private async invalidateDeadBrowser() {
    if (this.browser && (!this.browser.alive() || (this.dependencies.chrome.current && !await this.dependencies.chrome.current(this.browser)))) {
      await this.disconnect()
      this.browser = undefined
      this.pages.clear() // Browser crashes invalidate every old handle.
      this.pendingPages.clear() // The old browser cannot contain recoverable tabs.
      await this.dependencies.chrome.stop()
    }
  }

  private async call(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<CallToolResult> {
    try { return await this.mcp!.call(name, args, signal) } catch (error) {
      // Do not retry side effects. The next operation reconnects and remaps stable
      // tab identities; stale MCP indexes must never hit someone else's tab.
      await this.disconnect()
      throw error
    }
  }

  private async refresh() {
    const result = data(await this.call("list_pages", {}))
    if (!Array.isArray(result.pages)) throw new Error("Invalid MCP page catalog")
    const byTab = new Map<string, RawPage>()
    for (const raw of result.pages as RawPage[]) {
      const metadata = data(await this.call("get_tab_id", { pageId: raw.id }))
      if (typeof metadata.tabId !== "string") throw new Error("MCP stable tab identification is unavailable")
      byTab.set(metadata.tabId, raw)
    }
    for (const page of this.pages.values()) {
      const raw = byTab.get(page.tabId)
      if (!raw) { this.pages.delete(page.pageId); continue }
      page.upstreamId = raw.id
      page.url = raw.url
      page.title = raw.title
    }
  }

  private async createPage(sessionID: string, handle: string = randomUUID()): Promise<Page> {
    const marker = `about:blank#opencode-browser-use-${randomUUID()}`
    this.pendingPages.set(marker, sessionID)
    const result = data(await this.call("new_page", { url: marker, background: true }))
    const raw = (result.pages as RawPage[] | undefined)?.find((page) => page.url === marker)
    if (!raw) throw new Error("Could not identify the newly created tab")
    const metadata = data(await this.call("get_tab_id", { pageId: raw.id }))
    if (typeof metadata.tabId !== "string") throw new Error("Could not identify the new Chrome tab")
    const page: Page = { pageId: handle, sessionID, upstreamId: raw.id, tabId: metadata.tabId, url: raw.url, title: raw.title }
    this.pages.set(handle, page)
    this.pendingPages.delete(marker)
    return page
  }

  private async cleanupPending(sessionID?: string) {
    const markers = [...this.pendingPages].filter(([, owner]) => !sessionID || owner === sessionID)
    if (!markers.length) return
    if (!this.browser?.alive()) throw new Error("Cannot recover pending browser tabs while Chrome is unavailable")
    if (Cdp.disconnected(this.browser.cdp)) await Cdp.reconnect(this.browser.cdp)
    const { targetInfos } = await this.browser.cdp.send<{ targetInfos: Array<{ targetId: string; type: string; url: string }> }>(
      "Target.getTargets", { filter: [{ type: "tab" }] },
    )
    for (const [marker] of markers) {
      for (const target of targetInfos.filter((target) => target.type === "tab" && target.url === marker)) {
        await this.closeTab({ tabId: target.targetId } as Page)
      }
      this.pendingPages.delete(marker)
    }
  }

  private async transition(headless: boolean) {
    if (!this.restoration) {
      if (this.mcp && this.browser?.alive()) await this.refresh()
      this.restoration = [...this.pages.values()].map((page) => ({ ...page }))
    }
    await this.disconnect()
    await this.dependencies.chrome.stop(false)
    this.browser = undefined
    this.pages.clear()
    this.browser = await this.dependencies.chrome.start(headless)
    this.visibility = headless ? "headless" : "headed"
    this.mcp = await this.dependencies.connect(this.config.nodePath, this.browser.url)
    for (const saved of this.restoration) {
      const page = await this.createPage(saved.sessionID, saved.pageId)
      // Do not replay javascript/data/file URLs or form submissions during login.
      if (/^https?:\/\//i.test(saved.url)) {
        data(await this.call("navigate_page", { pageId: page.upstreamId, url: saved.url }))
      }
    }
    await this.refresh()
    this.restoration = undefined
  }

  async release(sessionID: string) { return this.serial.run(() => this.releaseSession(sessionID)) }

  private async releaseSession(sessionID: string) {
    await this.invalidateDeadBrowser()
    await this.cleanupPending(sessionID)
    if (this.login?.sessionID === sessionID) {
      await this.transition(true)
      this.login = undefined
    }
    if (this.restoration) this.restoration = this.restoration.filter((page) => page.sessionID !== sessionID)
    for (const page of this.pages.values()) {
      if (page.sessionID !== sessionID) continue
      // Stable CDP tab IDs, not potentially stale MCP indexes.
      if (this.browser?.alive()) {
        if (Cdp.disconnected(this.browser.cdp)) await Cdp.reconnect(this.browser.cdp)
        await this.closeTab(page)
      }
      this.pages.delete(page.pageId)
    }
    this.leases.delete(sessionID)
    if (!this.leases.size && this.idleAt === undefined) this.idleAt = this.dependencies.now()
  }

  private async closeTab(page: Page) {
    try { await this.browser!.cdp.send("Target.closeTarget", { targetId: page.tabId }) } catch (error) {
      // A human may have closed an owned tab since our last catalog refresh.
      if (!(error instanceof Error) || !/No target|not found|already closed/i.test(error.message)) throw error
    }
  }

  async sweep() {
    return this.serial.run(async () => {
      if (this.retired) return
      const now = this.dependencies.now()
      await this.invalidateDeadBrowser()
      if (this.login && now >= this.login.deadline) {
        await this.transition(true)
        this.login = undefined
      }
      const unloaded = this.unreferencedAt !== undefined && now - this.unreferencedAt >= this.config.unloadGraceMs
      for (const [sessionID, lease] of this.leases) {
        if (unloaded || now - lease.touched >= this.config.leaseTimeoutMs) await this.releaseSession(sessionID)
      }
      // A failed launch can leave recovery state even though no browser exists.
      if (!this.leases.size && (this.browser || this.restoration)) {
        this.idleAt ??= now
        if (now - this.idleAt >= this.config.idleTimeoutMs) await this.stop()
      }
      if (unloaded && !this.browser && !this.mcp && !this.leases.size && !this.login && !this.restoration) {
        this.retire()
      }
      // Preserve a headed selection made before launch; evicting that manager
      // would silently recreate it with the default headless visibility.
      if (this.evictWhenIdle && this.visibility === "headless" && this.serial.queued === 1 && !this.browser && !this.mcp && !this.leases.size && !this.login && !this.restoration && !this.pendingPages.size) this.retire(true)
      this.maintenanceError = undefined
    })
  }

  private async disconnect() {
    const mcp = this.mcp
    this.mcp = undefined
    await mcp?.close().catch(() => {})
  }

  private async stop() {
    await this.disconnect()
    await this.dependencies.chrome.stop()
    this.browser = undefined
    this.pages.clear()
    this.restoration = undefined
    this.visibility = "headless"
  }

  private retire(force = false) {
    if (this.references.size && !force) return
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
    this.retired = true
    for (const listener of this.retiredListeners) listener()
    this.retiredListeners.clear()
    this.references.clear()
    // A stale cleanup must never evict a newer owner of the same profile.
    if (managers.get(this.config.profileDirectory) === this) managers.delete(this.config.profileDirectory)
  }

  /** Explicit shutdown for integration tests and service-level owners. */
  async dispose() {
    return this.serial.run(async () => {
      if (this.timer) clearInterval(this.timer)
      this.timer = undefined
      this.leases.clear()
      this.login = undefined
      this.restoration = undefined
      await this.stop()
      this.retire(this.evictWhenIdle)
    })
  }

  /** Additive hot reloads keep live leases/tabs and the existing serialization queue. */
  static upgrade(manager: BrowserManager, connect?: typeof connectMcp) {
    Object.setPrototypeOf(manager, BrowserManager.prototype)
    // A relocated plugin must resolve future MCP subprocesses from its new path.
    if (connect) manager.dependencies.connect = connect
    // Migrate live managers from the old field without changing browser visibility.
    const legacy = manager as BrowserManager & { mode?: BrowserVisibility }
    manager.pendingPages ??= new Map()
    manager.retiredListeners ??= new Set()
    manager.visibility ??= legacy.mode ?? (manager.login ? "headed" : "headless")
    delete legacy.mode
  }
}

function pageView(page: Page): PublicPage {
  return { pageId: page.pageId, url: page.url, title: page.title }
}

// OpenCode instantiates plugins per location and reloads modules. A process-global
// registry keeps one owner across those instances, rather than one per import.
const key = Symbol.for("opencode.browser-use.managers.v1")
const root = globalThis as typeof globalThis & { [key]?: Map<string, BrowserManager> }
const managers = root[key] ??= new Map()

export function sharedManager(config: Options): BrowserManager {
  const current = managers.get(config.profileDirectory)
  if (current) {
    if (JSON.stringify(current.config) !== JSON.stringify(config)) {
      throw new Error("Browser plugin instances sharing a profile must use identical options")
    }
    BrowserManager.upgrade(current, connectMcp)
    return current
  }
  const manager = new BrowserManager(config)
  managers.set(config.profileDirectory, manager)
  return manager
}
