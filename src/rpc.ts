import { Rpc } from "@opencode/plugin/rpc"
import type { BrowserVisibility, PublicPage } from "./policy"

export interface PagesSnapshot { pages: PublicPage[]; visibility: BrowserVisibility; paused: boolean }
export const emptySnapshot = (): PagesSnapshot => ({ pages: [], visibility: "headless", paused: false })

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
          visibility: { type: "string", enum: ["headless", "headed"] },
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
        required: ["pages", "visibility", "paused"], additionalProperties: false,
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
  },
  events: {},
})
