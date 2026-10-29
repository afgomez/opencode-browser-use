import { Rpc } from "@opencode/plugin/rpc"
import type { BrowserMode, PublicPage } from "./policy"

export interface PagesSnapshot { pages: PublicPage[]; mode: BrowserMode; paused: boolean }
export const emptySnapshot = (): PagesSnapshot => ({ pages: [], mode: "headless", paused: false })

/** Trusted client API. The UI confirms mode changes; agent permission rules apply only to tools. */
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
          mode: { type: "string", enum: ["headless", "headed"] },
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
        required: ["pages", "mode", "paused"], additionalProperties: false,
      },
    },
    switchMode: {
      input: {
        type: "object",
        properties: {
          sessionID: { type: "string", minLength: 1 },
          mode: { type: "string", enum: ["headless", "headed"] },
        },
        required: ["sessionID", "mode"], additionalProperties: false,
      },
      output: { type: "object", additionalProperties: false },
      errors: { switch_failed: { type: "object", additionalProperties: false } },
    },
  },
  events: {},
})
