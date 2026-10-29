import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js"

// Deliberately reviewed allowlist. Never automatically expose new upstream tools.
export const pageTools = new Set([
  "click", "drag", "emulate", "evaluate_script", "fill", "fill_form",
  "get_console_message", "get_css_styles", "get_network_request", "handle_dialog",
  "hover", "list_console_messages", "list_network_requests", "navigate_page",
  "press_key", "resize_page", "take_screenshot", "take_snapshot", "type_text",
  "upload_file", "wait_for",
])

export type BrowserVisibility = "headed" | "headless"

export function browserVisibility(value: unknown): BrowserVisibility {
  if (value !== "headed" && value !== "headless") throw new Error("visibility must be headed or headless")
  return value
}

export function permissionFor(name: string) {
  return {
    action: "browser_use",
    resources: [name],
  }
}

export function wrappedCatalog(catalog: Tool[]): Tool[] {
  return catalog.filter((tool) => pageTools.has(tool.name)).map((tool) => {
    const inputSchema = structuredClone(tool.inputSchema)
    inputSchema.properties = {
      ...inputSchema.properties,
      pageId: { type: "string", description: "Session-owned page handle from browser_use_new_page or browser_use_list_pages." },
    }
    delete inputSchema.properties.serviceWorkerId
    inputSchema.required = [...new Set([...(inputSchema.required ?? []), "pageId"])]
    inputSchema.additionalProperties = false
    return { ...tool, inputSchema }
  })
}

export function data(result: CallToolResult): Record<string, unknown> {
  if (result.isError) {
    // Even an error's text can include global page listings or fallback dialogs.
    // Only forward dedicated error fields, never an unfiltered text response.
    const message = result.structuredContent?.errorMessage ?? result.structuredContent?.error
    throw new Error(typeof message === "string" ? message : "Chrome MCP tool failed")
  }
  if (!result.structuredContent || typeof result.structuredContent !== "object") {
    throw new Error("Chrome MCP did not return structured content; refusing unfiltered output")
  }
  return result.structuredContent
}

export interface PublicPage { pageId: string; url: string; title: string }

/** Never forward browser-wide text, fallback selection notices, or raw page IDs. */
export function filteredResult(result: CallToolResult, pages: PublicPage[]) {
  const structured = { ...data(result) }
  delete structured.pages
  delete structured.openedPages
  delete structured.extensionPages
  delete structured.extensionServiceWorkers
  delete structured.tabId
  delete structured.reconnected
  const content: Array<{ type: "text"; text: string } | { type: "file"; uri: string; mime: string }> = [
    { type: "text", text: JSON.stringify({ ...structured, pages }) },
  ]
  for (const item of result.content) {
    if (item.type === "image") {
      content.push({ type: "file", uri: `data:${item.mimeType};base64,${item.data}`, mime: item.mimeType })
    }
  }
  return { content }
}
