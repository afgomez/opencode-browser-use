import { homedir } from "node:os"
import { isAbsolute, join, resolve } from "node:path"

export interface Options {
  profileDirectory: string
  executablePath: string
  nodePath: string
  idleTimeoutMs: number
  leaseTimeoutMs: number
  loginTimeoutMs: number
  unloadGraceMs: number
}

export function options(input: Record<string, unknown> = {}): Options {
  const path = (name: string, fallback: string) => {
    const value = input[name] ?? fallback
    if (typeof value !== "string" || !value) throw new Error(`${name} must be a nonempty path`)
    const expanded = value.startsWith("~/") ? join(homedir(), value.slice(2)) : value
    if (!isAbsolute(expanded)) throw new Error(`${name} must be absolute`)
    return resolve(expanded)
  }
  const duration = (name: string, fallback: number) => {
    const value = input[name] ?? fallback
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 100) {
      throw new Error(`${name} must be an integer of at least 100 milliseconds`)
    }
    return value
  }
  const chrome = process.platform === "darwin"
    ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
    : process.platform === "win32"
      ? join(process.env.PROGRAMFILES ?? "C:\\Program Files", "Google/Chrome/Application/chrome.exe")
      : "/usr/bin/google-chrome"
  // OpenCode can be a compiled Bun executable, so process.execPath is not necessarily Node.
  const nodePath = input.nodePath ?? "node"
  if (typeof nodePath !== "string" || !nodePath) throw new Error("nodePath must be a nonempty executable")
  return {
    profileDirectory: path("profileDirectory", join(homedir(), ".cache/opencode/browser_use/chrome-profile")),
    executablePath: path("executablePath", chrome),
    nodePath,
    idleTimeoutMs: duration("idleTimeoutMs", 60_000),
    leaseTimeoutMs: duration("leaseTimeoutMs", 30 * 60_000),
    loginTimeoutMs: duration("loginTimeoutMs", 10 * 60_000),
    unloadGraceMs: duration("unloadGraceMs", 30_000),
  }
}
