import { spawn, type ChildProcess } from "node:child_process"
import { mkdir, readFile, rm, unlink, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import lockfile from "proper-lockfile"
import { Cdp } from "./cdp"
import type { Options } from "./options"

interface Advertisement { pid: number; endpoint: string }

export interface BrowserProcess {
  url: string
  cdp: Cdp
  alive(): boolean
  stop(): Promise<void>
}

export function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM"
  }
}

export class Chrome {
  private unlock?: () => Promise<void>
  private compromised = false
  private browser?: BrowserProcess

  constructor(private config: Options) {}

  async start(headless: boolean): Promise<BrowserProcess> {
    await this.lock()
    try {
      // A service crash can leave Chrome alive. Reattach only to an advertisement
      // we wrote, and verify the browser's exact profile before trusting it.
      if (!this.browser) this.browser = await this.recover()
      if (this.browser) {
        await this.browser.stop()
        this.browser = undefined
      }
      this.browser = await this.launch(headless)
      return this.browser
    } catch (error) {
      await this.release()
      throw error
    }
  }

  private async lock() {
    if (this.compromised) throw new Error("Browser profile lock was lost; reload the plugin before continuing")
    const profile = this.config.profileDirectory
    await mkdir(profile, { recursive: true, mode: 0o700 })
    if (!this.unlock) {
      try {
        this.unlock = await lockfile.lock(profile, {
          // The lock must survive removal of the profile itself.
          lockfilePath: `${profile}.opencode-browser-use.lock`,
          stale: 30_000, update: 10_000, retries: 0,
          onCompromised: () => {
            this.compromised = true
            // Do not keep controlling a browser after losing exclusive ownership.
            this.browser?.cdp.close()
          },
        })
      } catch {
        throw new Error("This browser profile is managed by another OpenCode service. Use that service or a different profileDirectory.")
      }
    }
  }

  /** On session deletion stop a verified survivor before removing its profile. */
  async removeProfile(): Promise<void> {
    await this.lock()
    try {
      this.browser ??= await this.recover()
      if (this.browser) { await this.browser.stop(); this.browser = undefined }
      await rm(this.config.profileDirectory, { recursive: true, force: true })
    } finally { await this.release() }
  }

  private async recover(): Promise<BrowserProcess | undefined> {
    let saved: Advertisement
    try { saved = JSON.parse(await readFile(this.advertisement(), "utf8")) } catch { return }
    if (!Number.isSafeInteger(saved.pid) || !pidAlive(saved.pid)) return
    const endpoint = new URL(saved.endpoint)
    if (endpoint.protocol !== "ws:" || endpoint.hostname !== "127.0.0.1") {
      throw new Error("Invalid browser recovery advertisement")
    }
    const cdp = await Cdp.connect(saved.endpoint)
    try {
      const { arguments: args } = await cdp.send<{ arguments: string[] }>("Browser.getBrowserCommandLine")
      if (!args.includes(`--user-data-dir=${this.config.profileDirectory}`)) {
        throw new Error("Recovery endpoint does not belong to this browser profile")
      }
    } catch (error) { cdp.close(); throw error }
    return this.connection(saved, cdp)
  }

  private advertisement() { return join(this.config.profileDirectory, ".opencode-browser-use.json") }

  private async launch(headless: boolean): Promise<BrowserProcess> {
    let stderr = ""
    let launchError: Error | undefined
    const child: ChildProcess = spawn(this.config.executablePath, [
      `--user-data-dir=${this.config.profileDirectory}`,
      "--remote-debugging-address=127.0.0.1", "--remote-debugging-port=0",
      "--enable-automation", "--no-first-run", "--no-default-browser-check",
      "--disable-background-mode", "--disable-sync", "--disable-session-crashed-bubble",
      "--password-store=basic", "--use-mock-keychain", "--window-size=1440,1000",
      ...(headless ? ["--headless=new"] : []), "about:blank",
    ], { stdio: ["ignore", "ignore", "pipe"] })
    child.on("error", (error) => { launchError = error })
    child.stderr?.on("data", (chunk) => { stderr = (stderr + String(chunk)).slice(-16_384) })
    try {
      let endpoint: string | undefined
      for (let attempt = 0; attempt < 200; attempt++) {
        if (launchError) throw launchError
        if (child.exitCode !== null || child.signalCode !== null) {
          throw new Error("Chrome exited during startup. The profile may already be open in another browser.")
        }
        endpoint = stderr.match(/DevTools listening on (ws:\/\/127\.0\.0\.1:\d+\/devtools\/browser\/[^\s]+)/)?.[1]
        if (endpoint) break
        await delay(100)
      }
      if (!endpoint || !child.pid) throw new Error("Chrome did not publish its debugging endpoint")
      const cdp = await Cdp.connect(endpoint)
      const saved: Advertisement = { pid: child.pid, endpoint }
      await writeFile(this.advertisement(), JSON.stringify(saved), { mode: 0o600 })
      return this.connection(saved, cdp, child)
    } catch (error) {
      child.kill("SIGTERM")
      throw error
    }
  }

  private connection(saved: Advertisement, cdp: Cdp, child?: ChildProcess): BrowserProcess {
    const endpoint = new URL(saved.endpoint)
    return {
      url: `http://127.0.0.1:${endpoint.port}`,
      cdp,
      alive: () => !this.compromised && (child
        ? child.exitCode === null && child.signalCode === null
        : pidAlive(saved.pid)),
      stop: async () => {
        await cdp.send("Browser.close").catch(() => {})
        cdp.close()
        for (let i = 0; i < 100 && pidAlive(saved.pid); i++) await delay(100)
        if (pidAlive(saved.pid)) {
          // Never relaunch into a profile still owned by an unresponsive Chrome.
          throw new Error("Chrome has not exited; refusing to relaunch into its profile")
        }
        await unlink(this.advertisement()).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== "ENOENT") throw error
        })
      },
    }
  }

  /** Keep the profile lock across headed/headless transitions. */
  async stop(release = true): Promise<void> {
    try {
      if (this.browser) { await this.browser.stop(); this.browser = undefined }
    } finally { if (release) await this.release() }
  }

  private async release() {
    const unlock = this.unlock
    this.unlock = undefined
    if (unlock && !this.compromised) await unlock()
  }
}
