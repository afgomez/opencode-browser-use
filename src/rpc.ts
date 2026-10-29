import { Rpc } from "@opencode/plugin/rpc"
import type { BrowserVisibility, PublicPage } from "./policy"
import type { BrowserMode } from "./router"

export interface PagesSnapshot { pages: PublicPage[]; visibility: BrowserVisibility | null; paused: boolean; mode: BrowserMode }
export const emptySnapshot = (): PagesSnapshot => ({ pages: [], visibility: "headless", paused: false, mode: "shared" })

/** Trusted client API. The UI confirms visibility changes; agent permission rules apply only to tools. */
export const BrowserUse = Rpc.define({
  id: "browser-use",
  methods: {
    pages: {
      input: {
        type: "object",
        properties: { sessionID: { type: "string", minLength: 1 } },
        required: ["sessionID"], additionalProperties: false,
      },
      output: {
        type: "object",
        properties: {
          visibility: { anyOf: [{ type: "string", enum: ["headless", "headed"] }, { type: "null" }] },
          mode: { type: "string", enum: ["shared", "isolated", "attach"] },
          paused: { type: "boolean" },
          pages: {
            type: "array",
            items: {
              type: "object",
              properties: { pageId: { type: "string" }, title: { type: "string" }, url: { type: "string" } },
              required: ["pageId", "title", "url"], additionalProperties: false,
            },
          },
        },
        required: ["pages", "visibility", "paused", "mode"], additionalProperties: false,
      },
    },
    setVisibility: {
      input: {
        type: "object",
        properties: {
          sessionID: { type: "string", minLength: 1 },
          visibility: { type: "string", enum: ["headless", "headed"] },
        },
        required: ["sessionID", "visibility"], additionalProperties: false,
      },
      output: { type: "object", additionalProperties: false },
      errors: { switch_failed: { type: "object", additionalProperties: false } },
    },
    setMode: {
      input: {
        type: "object",
        properties: { sessionID: { type: "string", minLength: 1 }, mode: { type: "string", enum: ["shared", "isolated", "attach"] } },
        required: ["sessionID", "mode"], additionalProperties: false,
      },
      output: { type: "object", additionalProperties: false },
      errors: { switch_failed: { type: "object", additionalProperties: false } },
    },
  },
  events: {},
})
