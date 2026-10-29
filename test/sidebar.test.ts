import assert from "node:assert/strict"
import { test } from "node:test"
import { singleLine, watchPages } from "../src/sidebar"
import { emptySnapshot, type PagesSnapshot } from "../src/rpc"

const snapshot: PagesSnapshot = { ...emptySnapshot(), pages: [{ pageId: "a", title: "Flows", url: "http://localhost:3000/flows" }] }
const settle = async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve() }

test("sidebar polling refreshes without overlapping reads and stops on cleanup", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] })
  let finish!: (value: PagesSnapshot) => void
  let signal!: AbortSignal
  let reads = 0
  const updates: PagesSnapshot[] = []
  const stop = watchPages((input) => {
    signal = input
    reads++
    return new Promise((resolve) => { finish = resolve })
  }, (value) => updates.push(value))
  try {
    assert.equal(reads, 1)
    t.mock.timers.tick(10_000)
    assert.equal(reads, 1)
    finish(snapshot)
    await settle()
    assert.deepEqual(updates, [snapshot])
    t.mock.timers.tick(1000)
    assert.equal(reads, 2)
    stop()
    assert.equal(signal.aborted, true)
    finish(emptySnapshot())
    await settle()
    t.mock.timers.tick(10_000)
    assert.equal(reads, 2)
    assert.deepEqual(updates, [snapshot])
  } finally { stop() }
})

test("sidebar polls changed metadata and the last tab closing at the refresh interval", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] })
  let current = snapshot
  const updates: PagesSnapshot[] = []
  const stop = watchPages(async () => current, (value) => updates.push(value))
  try {
    await settle()
    const changed: PagesSnapshot = { ...snapshot, visibility: "headed", pages: [{ pageId: "a", title: "After", url: "https://after.test/" }] }
    current = changed
    t.mock.timers.tick(999)
    await settle()
    assert.deepEqual(updates, [snapshot])
    t.mock.timers.tick(1)
    await settle()
    assert.deepEqual(updates, [snapshot, changed])
    current = emptySnapshot()
    t.mock.timers.tick(1000)
    await settle()
    assert.deepEqual(updates, [snapshot, changed, emptySnapshot()])
  } finally { stop() }
})

test("a disconnected sidebar clears stale tabs and can recover on the next poll", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] })
  let reads = 0
  let failures = 0
  const updates: PagesSnapshot[] = []
  const stop = watchPages(async () => {
    if (++reads === 2) throw new Error("Server disconnected")
    return snapshot
  }, (value) => updates.push(value), 1000, () => { failures++ })
  try {
    await settle()
    t.mock.timers.tick(1000)
    await settle()
    t.mock.timers.tick(1000)
    await settle()
    assert.deepEqual(updates, [snapshot, emptySnapshot(), snapshot])
    assert.equal(failures, 1)
  } finally { stop() }
})

test("switching sessions discards late responses and aborts the previous session's read", async () => {
  let finish!: (value: PagesSnapshot) => void
  let signal!: AbortSignal
  const updates: PagesSnapshot[] = []
  const old = watchPages((input) => {
    signal = input
    return new Promise((resolve) => { finish = resolve })
  }, (value) => updates.push(value))
  old()
  const current = watchPages(async () => emptySnapshot(), (value) => updates.push(value))
  try {
    finish(snapshot)
    await settle()
    assert.equal(signal.aborted, true)
    assert.deepEqual(updates, [emptySnapshot()])
  } finally { current() }
})

test("sidebar labels cannot inject newlines or terminal controls", () => {
  assert.equal(singleLine("\nFlows\tpage\r\u001b\u009b"), "Flows page")
  assert.equal(singleLine("   "), "")
  assert.equal(singleLine("日本語 🦊"), "日本語 🦊")
})
