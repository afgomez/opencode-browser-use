import { readFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import { Cdp } from "./cdp"
import type { BrowserProcess } from "./chrome"

/** Connect only to Chrome's user-enabled remote debugging endpoint; never launch it. */
export class AttachChrome {
  private browser?: BrowserProcess
  constructor(private directory?: string) {}

  private async endpoint() {
    const directory = this.directory ?? (process.platform === "darwin"
      ? join(homedir(), "Library/Application Support/Google/Chrome")
      : process.platform === "win32"
        ? join(process.env.LOCALAPPDATA ?? join(homedir(), "AppData/Local"), "Google/Chrome/User Data")
        : join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "google-chrome"))
    const [port, path] = (await readFile(join(directory, "DevToolsActivePort"), "utf8")).trim().split(/\r?\n/)
    if (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535 || !/^\/devtools\/browser\/[\w-]+$/.test(path)) throw new Error("Invalid endpoint")
    return `ws://127.0.0.1:${port}${path}`
  }

  // Missing or partially written endpoint files are not proof of a restart.
  async current(browser: BrowserProcess): Promise<boolean> {
    try { return await this.endpoint() === browser.url } catch { return true }
  }

  async start(_headless: boolean): Promise<BrowserProcess> {
    try {
      const url = await this.endpoint()
      const cdp = await Cdp.connect(url, 60_000)
      // A dropped metadata socket is not evidence that the user's browser died.
      // Keep the endpoint and tab ownership until reconnection or explicit release.
      this.browser = { url, cdp, alive: () => true, stop: async () => cdp.close() }
      return this.browser
    } catch (error) {
      throw new Error("Cannot attach to your running Chrome. Enable remote debugging at chrome://inspect/#remote-debugging and approve connection requests; Chrome 144 or newer is required. No other browser will be launched.", { cause: error })
    }
  }

  async stop(): Promise<void> {
    await this.browser?.stop()
    this.browser = undefined
  }
}
