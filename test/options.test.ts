import assert from "node:assert/strict"
import { homedir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { options } from "../src/options"

test("the default Chrome profile is specific to OpenCode browser_use", () => {
  assert.equal(options().profileDirectory, join(homedir(), ".cache/opencode/browser_use/chrome-profile"))
  assert.notEqual(options().profileDirectory, join(homedir(), ".cache/chrome-devtools-mcp/chrome-profile"))
})

test("an explicit profileDirectory still overrides the default and expands home", () => {
  assert.equal(options({ profileDirectory: "~/custom-browser-profile" }).profileDirectory, join(homedir(), "custom-browser-profile"))
})
