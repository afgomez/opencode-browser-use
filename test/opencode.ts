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
      { action: "browser_use", resource: "switch_mode.headed", effect: "ask" },
    ],
  }))
  const reservation = createServer()
  await new Promise<void>((resolve) => reservation.listen(0, "127.0.0.1", resolve))
  const port = (reservation.address() as { port: number }).port
  await new Promise<void>((resolve) => reservation.close(() => resolve()))
  const password = "browser-use-local-integration-test"
  const child = spawn("opencode", ["serve", "--hostname", "127.0.0.1", "--port", String(port)], {
    cwd: project,
    env: { ...process.env, HOME: directory, XDG_CONFIG_HOME: join(directory, "config"), XDG_DATA_HOME: join(directory, "data"), XDG_CACHE_HOME: join(directory, "cache"), XDG_STATE_HOME: join(directory, "state"), OPENCODE_DB: ":memory:", OPENCODE_PASSWORD: password },
    stdio: ["ignore", "pipe", "pipe"],
  })
  let log = ""
  child.stdout.on("data", (chunk) => { log = (log + String(chunk)).slice(-20_000) })
  child.stderr.on("data", (chunk) => { log = (log + String(chunk)).slice(-20_000) })
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
    const response = await fetch(`http://127.0.0.1:${port}/api/agent?location[directory]=${encodeURIComponent(project)}`, { headers })
    assert.ok(response.ok)
    const agents = await response.json() as any
    const build = agents.data.find((agent: any) => agent.id === "build")
    assert.deepEqual(build.permissions.filter((rule: any) => rule.action === "browser_use"), [
      { action: "browser_use", resource: "*", effect: "allow" },
      { action: "browser_use", resource: "login_start", effect: "ask" },
      { action: "browser_use", resource: "switch_mode.headed", effect: "ask" },
    ])
  } finally {
    const exited = once(child, "exit")
    child.kill("SIGTERM")
    await exited
    await rm(directory, { recursive: true, force: true })
  }
})
