import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { once } from "node:events"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { setTimeout as delay } from "node:timers/promises"
import { fileURLToPath } from "node:url"
import { OpenCode } from "@opencode/client"
import { BrowserUse, emptySnapshot } from "../src/rpc"

test("the real OpenCode V2 server loads the explicitly configured local plugin as active", { timeout: 60_000 }, async () => {
  const base = join(tmpdir(), "opencode")
  await mkdir(base, { recursive: true })
  const directory = await mkdtemp(join(base, "browser-use-opencode-test-"))
  const project = join(directory, "project")
  const config = join(directory, "config/opencode")
  await mkdir(project)
  await mkdir(config, { recursive: true })
  const localPlugin = fileURLToPath(new URL("../", import.meta.url))
  await writeFile(join(config, "opencode.json"), JSON.stringify({
    $schema: "https://opencode.ai/config.json",
    plugins: [localPlugin],
    permissions: [
      { action: "browser_use", resource: "*", effect: "allow" },
      { action: "browser_use", resource: "login_start", effect: "ask" },
    ],
  }))
  const reservation = createServer()
  await new Promise<void>((resolve) => reservation.listen(0, "127.0.0.1", resolve))
  const port = (reservation.address() as { port: number }).port
  await new Promise<void>((resolve) => reservation.close(() => resolve()))
  const password = "browser-use-local-integration-test"
  let log = ""
  const start = () => {
    const child = spawn("opencode", ["serve", "--hostname", "127.0.0.1", "--port", String(port)], {
      cwd: project,
      env: { ...process.env, HOME: directory, XDG_CONFIG_HOME: join(directory, "config"), XDG_DATA_HOME: join(directory, "data"), XDG_CACHE_HOME: join(directory, "cache"), XDG_STATE_HOME: join(directory, "state"), OPENCODE_DB: join(directory, "opencode.db"), OPENCODE_PASSWORD: password },
      stdio: ["ignore", "pipe", "pipe"],
    })
    child.stdout.on("data", (chunk) => { log = (log + String(chunk)).slice(-20_000) })
    child.stderr.on("data", (chunk) => { log = (log + String(chunk)).slice(-20_000) })
    return child
  }
  let child = start()
  const headers = { Authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}` }
  try {
    let loaded: any
    for (let i = 0; i < 150; i++) {
      try {
        const response = await fetch(`http://127.0.0.1:${port}/api/plugin?location[directory]=${encodeURIComponent(project)}`, { headers, signal: AbortSignal.timeout(5000) })
        if (response.ok) {
          const result = await response.json() as any
          loaded = result.data.find((entry: any) => entry.id === "browser-use")
          if (loaded) assert.equal(result.data.filter((entry: any) => entry.id === "browser-use").length, 1)
          if (loaded) break
        }
      } catch {}
      if (child.exitCode !== null) throw new Error(`OpenCode exited: ${log}`)
      await delay(100)
    }
    assert.ok(loaded, `Plugin did not load. Server output:\n${log}`)
    assert.equal(loaded.state.status, "active", JSON.stringify(loaded))
    assert.equal(loaded.features.tui, true, "the real server must advertise the TUI entrypoint to clients")
    const response = await fetch(`http://127.0.0.1:${port}/api/agent?location[directory]=${encodeURIComponent(project)}`, { headers })
    assert.ok(response.ok)
    const agents = await response.json() as any
    const build = agents.data.find((agent: any) => agent.id === "build")
    assert.deepEqual(build.permissions.filter((rule: any) => rule.action === "browser_use"), [
      { action: "browser_use", resource: "*", effect: "allow" },
      { action: "browser_use", resource: "login_start", effect: "ask" },
    ])
    const browser = OpenCode.make({ baseUrl: `http://127.0.0.1:${port}`, headers }).rpc(BrowserUse)
    const request = { location: { directory: project } }
    assert.deepEqual(await browser.pages({ sessionID: "sidebar-test" }, request), { ...emptySnapshot(), mode: "shared" })
    for (const input of [{}, { sessionID: "" }, { sessionID: 1 }]) {
      await assert.rejects(browser.pages(input, request), { type: "rpc.invalid_input" })
    }
    await assert.rejects(browser.setVisibility({ sessionID: "sidebar-test", visibility: "visible" }, request), { type: "rpc.invalid_input" })
    await assert.rejects(browser.setVisibility({ sessionID: "sidebar-test", mode: "headless" }, request), { type: "rpc.invalid_input" })
    const client = OpenCode.make({ baseUrl: `http://127.0.0.1:${port}`, headers })
    const session = await client.session.create({ location: { directory: project }, title: "Sidebar visibility permissions" })
    await client.session.update({ sessionID: session.id, permissions: [{ action: "browser_use", resource: "*", effect: "deny" }] })
    assert.deepEqual(await browser.setVisibility({ sessionID: session.id, visibility: "headless" }, request), {}, "direct user control must ignore agent deny rules")
    await client.session.update({ sessionID: session.id, permissions: [{ action: "browser_use", resource: "*", effect: "allow" }] })
    assert.deepEqual(await browser.setVisibility({ sessionID: session.id, visibility: "headless" }, request), {})
    assert.deepEqual(await browser.setMode({ sessionID: session.id, mode: "isolated" }, request), {})
    assert.equal((await browser.pages({ sessionID: session.id }, request) as { mode: string }).mode, "isolated")
    assert.equal((await browser.pages({ sessionID: "sidebar-test" }, request) as { mode: string }).mode, "shared")
    await assert.rejects(browser.setMode({ sessionID: session.id, mode: "invalid" }, request), { type: "rpc.invalid_input" })
    const exited = once(child, "exit")
    child.kill("SIGTERM")
    await exited
    child = start()
    let restored: unknown
    for (let i = 0; i < 150; i++) {
      try { restored = await browser.pages({ sessionID: session.id }, request); break } catch {}
      if (child.exitCode !== null) throw new Error(`OpenCode exited after restart: ${log}`)
      await delay(100)
    }
    assert.equal((restored as { mode?: string } | undefined)?.mode, "isolated", "mode survives a real service restart")
  } finally {
    const exited = once(child, "exit")
    child.kill("SIGTERM")
    await exited
    await rm(directory, { recursive: true, force: true })
  }
})
