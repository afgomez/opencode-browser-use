import { createRequire } from "node:module"
import { pathToFileURL } from "node:url"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"
import { ListRootsRequestSchema, type CallToolResult, type Tool } from "@modelcontextprotocol/sdk/types.js"

const require = createRequire(import.meta.url)
const executable = require.resolve("chrome-devtools-mcp/build/src/bin/chrome-devtools-mcp.js")

export interface Mcp {
  tools(): Promise<Tool[]>
  call(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<CallToolResult>
  roots(directory: string): Promise<void>
  close(): Promise<void>
}

export async function connectMcp(nodePath: string, browserUrl: string): Promise<Mcp> {
  let directory: string | undefined
  const client = new Client({ name: "opencode-browser-use", version: "0.1.0" }, {
    capabilities: { roots: { listChanged: true } },
  })
  client.setRequestHandler(ListRootsRequestSchema, async () => ({
    roots: directory ? [{ uri: pathToFileURL(directory).href, name: "session workspace" }] : [],
  }))
  const transport = new StdioClientTransport({
    command: nodePath,
    args: [executable, `${browserUrl.startsWith("ws:") ? "--ws-endpoint" : "--browser-url"}=${browserUrl}`, "--page-id-routing",
      "--experimental-structured-content", "--experimental-interop-tools",
      "--redact-network-headers", "--no-usage-statistics", "--no-performance-crux",
      "--no-category-performance", "--no-category-memory"],
    stderr: "pipe",
  })
  // Drain without logging URLs, cookies, page content, or profile paths.
  transport.stderr?.on("data", () => {})
  try {
    await client.connect(transport, { timeout: 30_000 })
  } catch (error) {
    await transport.close().catch(() => {})
    throw error
  }
  return {
    async tools() { return (await client.listTools()).tools },
    async call(name, args, signal) {
      return await client.callTool({ name, arguments: args }, undefined, {
        signal, timeout: 120_000, maxTotalTimeout: 120_000,
      }) as CallToolResult
    },
    async roots(value) {
      if (directory === value) return
      directory = value
      await client.sendRootsListChanged()
    },
    async close() { await client.close() },
  }
}

/** Catalog requests are lazy-browser operations: this never launches Chrome. */
export async function loadCatalog(nodePath: string): Promise<Tool[]> {
  const mcp = await connectMcp(nodePath, "http://127.0.0.1:1")
  try { return await mcp.tools() } finally { await mcp.close() }
}
