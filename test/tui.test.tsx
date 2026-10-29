import assert from "node:assert/strict"
import { test } from "node:test"
import { testRender } from "@opentui/solid"
import { PluginContextProvider } from "@opencode/plugin/tui"
import type { Context } from "@opencode/plugin/tui/context"
import { createSignal } from "solid-js"
import { RGBA, TextAttributes } from "@opentui/core"
import tui, { BrowserSidebar } from "../src/tui"
import { emptySnapshot, type PagesSnapshot } from "../src/rpc"
import type { BrowserMode } from "../src/policy"
import { spinnerFrames } from "../src/spinner"

const hasSpinner = (frame: string) => spinnerFrames.some((glyph) => frame.includes(glyph))
const hasModeButton = (frame: string, mode: "Headless" | "Headed") => frame.split("\n").some((line) => line.includes("Browser use") && line.includes(mode))
const actionColor = (base: string, hovered: string, disabled: string, focused = base) => ({
  base, hovered, disabled, focused,
  state: (states: { disabled?: boolean; hovered?: boolean; focused?: boolean }) => states.disabled ? disabled : states.focused ? focused : states.hovered ? hovered : base,
})
const theme = {
  text: { base: "#ffffff", muted: "#888888", action: { primary: actionColor("#111111", "#222222", "#999999") } },
  background: { action: { primary: actionColor("#00000000", "#333333", "#333333", "#88aaff") } },
  increase: (color: string) => color === "#88aaff" ? "#aaccff" : color,
}

test("the TUI entrypoint appends a disposable sidebar contribution", async () => {
  let claim: any
  let disposed = false
  const cleanup = await tui.setup({
    ui: { slot(input: unknown) { claim = input; return () => { disposed = true } } },
  } as unknown as Context)
  assert.equal(claim.append, "sidebar.content")
  assert.equal(typeof claim.render, "function")
  assert.ok(cleanup)
  await cleanup()
  assert.equal(disposed, true)
})

test("sidebar renders title, muted URL, fallback and truncation; switching sessions clears old tabs", async () => {
  const [session, setSession] = createSignal("a")
  const calls: Array<{ sessionID: string; location: { directory: string }; signal: AbortSignal }> = []
  let finishB!: (value: PagesSnapshot) => void
  const context = {
    client: { rpc() { return { pages(input: { sessionID: string }, options: { location: { directory: string }; signal: AbortSignal }) {
      calls.push({ ...input, ...options })
      if (input.sessionID === "b") return new Promise<PagesSnapshot>((resolve) => { finishB = resolve })
      if (input.sessionID === "empty") return Promise.resolve(emptySnapshot())
      return Promise.resolve({ ...emptySnapshot(), pages: [
        { pageId: "a1", title: "Flows", url: "http://localhost:3000/flows" },
        { pageId: "a2", title: " \n\t ", url: `https://example.com/${"long-path/".repeat(20)}` },
      ] })
    } } } },
    data: { session: { get(id: string) { return { location: { directory: `/workspace/${id}` } } } } },
    theme,
  } as unknown as Context
  const ui = await testRender(() => (
    <PluginContextProvider value={context}>
      <BrowserSidebar sessionID={session()} />
    </PluginContextProvider>
  ), { width: 40, height: 16 })
  try {
    const frame = await ui.waitForFrame((frame) => frame.includes("Flows"))
    assert.match(frame, /Browser use · 2 tabs/)
    assert.match(frame, /http:\/\/localhost:3000\/flows/)
    assert.match(frame, /Untitled/)
    assert.ok(hasModeButton(frame, "Headless"), "the mode button belongs on the title row")
    assert.ok(!frame.includes("[ Headless ]"), "the highlighted button should not have text brackets")
    assert.ok(!frame.includes("Mode:"))
    assert.ok(frame.includes("Headless ▾"), "the button arrow should indicate more options")
    assert.ok(!frame.includes("long-path/".repeat(5)), "long URLs must not wrap onto extra lines")
    assert.deepEqual(calls[0].location, { directory: "/workspace/a" })
    setSession("b")
    await ui.waitForFrame((frame) => !frame.includes("Browser use"))
    assert.equal(calls[0].signal.aborted, true)
    assert.deepEqual(calls.at(-1)!.location, { directory: "/workspace/b" })
    finishB({ ...emptySnapshot(), pages: [{ pageId: "b1", title: "Only session B", url: "https://b.test/" }] })
    const next = await ui.waitForFrame((frame) => frame.includes("Only session B"))
    assert.match(next, /Browser use · 1 tab/)
    assert.ok(!next.includes("Flows"))
    setSession("empty")
    await ui.waitForFrame((frame) => !frame.includes("Browser use"))
  } finally {
    await ui.dispose()
  }
  assert.equal(calls.at(-1)!.signal.aborted, true)
})

test("sidebar polling updates titles/URLs and hides the section when the last tab closes", async () => {
  let current: PagesSnapshot = { ...emptySnapshot(), pages: [{ pageId: "a", title: "Before", url: "https://before.test/" }] }
  const context = {
    client: { rpc() { return { async pages() { return current } } } },
    data: { session: { get() { return { location: { directory: "/workspace" } } } } },
    theme,
  } as unknown as Context
  const ui = await testRender(() => (
    <PluginContextProvider value={context}>
      <BrowserSidebar sessionID="a" />
    </PluginContextProvider>
  ), { width: 40, height: 10 })
  try {
    await ui.waitForFrame((frame) => frame.includes("Before"))
    current = { ...emptySnapshot(), mode: "headed", pages: [{ pageId: "a", title: "After", url: "https://after.test/" }] }
    await new Promise((resolve) => setTimeout(resolve, 1100))
    const changed = await ui.waitForFrame((frame) => frame.includes("After"))
    assert.match(changed, /https:\/\/after.test\//)
    const active = ui.captureSpans().lines.flatMap((line) => line.spans).find((span) => span.text.trim() === "Headed")!
    assert.ok(active.attributes & TextAttributes.BOLD, "external mode changes must update the highlight")
    current = emptySnapshot()
    await new Promise((resolve) => setTimeout(resolve, 1100))
    await ui.waitForFrame((frame) => !frame.includes("Browser use"))
  } finally { await ui.dispose() }
})

async function modeFixture() {
  const [session, setSession] = createSignal("a")
  const f = {
    snapshot: { ...emptySnapshot(), pages: [{ pageId: "a", title: "Flows", url: "https://a.test/" }] },
    confirmations: [] as Array<{ title: string; message: string }>,
    selections: [] as Array<{ title: string; current: BrowserMode; options: Array<{ title: string; value: BrowserMode }> }>,
    calls: [] as Array<{ sessionID: string; mode: BrowserMode; location: { directory: string }; signal: AbortSignal }>,
    toasts: [] as Array<{ message: string }>,
    failRead: false,
    selected: "headed" as BrowserMode,
    select: async () => f.selected as BrowserMode | undefined,
    confirm: async () => true as boolean | undefined,
    change: async (_mode: BrowserMode) => {},
  }
  f.change = async (mode) => { f.snapshot = { ...f.snapshot, mode } }
  const context = {
    client: { rpc() { return {
      async pages() { if (f.failRead) throw new Error("Chrome disconnected"); return f.snapshot },
      async switchMode(input: { sessionID: string; mode: BrowserMode }, options: { location: { directory: string }; signal: AbortSignal }) {
        f.calls.push({ ...input, ...options })
        await f.change(input.mode)
        return {}
      },
    } } },
    data: { session: { get(id: string) { return { location: { directory: `/workspace/${id}` } } } } },
    theme,
    ui: {
      dialog: {
        async select(input: (typeof f.selections)[number]) { f.selections.push(input); return f.select() },
        async confirm(input: { title: string; message: string }) { f.confirmations.push(input); return f.confirm() },
      },
      toast: { show(input: { message: string }) { f.toasts.push(input) } },
    },
  } as unknown as Context
  const ui = await testRender(() => (
    <PluginContextProvider value={context}><BrowserSidebar sessionID={session()} /></PluginContextProvider>
  ), { width: 45, height: 12 })
  await ui.waitForFrame((frame) => hasModeButton(frame, "Headless"))
  const position = () => {
    const lines = ui.captureCharFrame().split("\n")
    const y = lines.findIndex((line) => /Head(?:less|ed)/.test(line))
    assert.ok(y >= 0)
    return { x: lines[y].indexOf("Head") + 1, y }
  }
  const click = async (mode: BrowserMode) => {
    f.selected = mode
    const { x, y } = position()
    await ui.mockMouse.click(x, y)
  }
  const active = () => ui.captureSpans().lines.flatMap((line) => line.spans)
    .filter((span) => /^(Headless|Headed)$/.test(span.text.trim()) && (span.attributes & TextAttributes.BOLD))
    .map((span) => span.text.trim().toLowerCase())
  return { f, ui, click, active, setSession, position }
}

test("mode controls highlight the active mode and confirm clicks before switching either direction", async () => {
  const { f, ui, click, active } = await modeFixture()
  try {
    assert.deepEqual(active(), ["headless"])
    await click("headless")
    assert.equal(f.confirmations.length, 0, "choosing the active mode is a no-op")
    assert.equal(f.selections[0].current, "headless")
    assert.deepEqual(f.selections[0].options.map((option) => option.value), ["headless", "headed"])
    for (const mode of ["headed", "headless"] as const) {
      await click(mode)
      await ui.waitForFrame((frame) => hasModeButton(frame, mode === "headed" ? "Headed" : "Headless") && !hasSpinner(frame))
      assert.equal(f.calls.at(-1)!.mode, mode)
      assert.equal(f.selections.at(-1)!.title, "Browser mode")
      assert.deepEqual(f.calls.at(-1)!.location, { directory: "/workspace/a" })
      assert.equal(f.calls.at(-1)!.sessionID, "a")
      assert.match(f.confirmations.at(-1)!.message, /every session's tabs/)
      assert.deepEqual(active(), [mode])
    }
    assert.equal(f.confirmations.length, 2)
  } finally { await ui.dispose() }
})

test("the opening click finishes before showing the confirmation and leaves it pending for user input", async () => {
  const { f, ui, position } = await modeFixture()
  let confirm!: (value: boolean) => void
  f.confirm = () => new Promise((resolve) => { confirm = resolve })
  try {
    const { x, y } = position()
    await ui.mockMouse.pressDown(x, y)
    await ui.renderOnce()
    assert.equal(f.confirmations.length, 0, "opening on mouse-down exposes the dialog to the same click's release")
    assert.equal(f.selections.length, 0)
    await ui.mockMouse.release(x, y)
    await ui.waitFor(() => f.confirmations.length === 1)
    assert.equal(f.confirmations.length, 1)
    assert.equal(f.calls.length, 0)
    await ui.renderOnce()
    assert.ok(!hasSpinner(ui.captureCharFrame()), "waiting for confirmation must not show a switching spinner")
    await ui.mockMouse.click(x, y)
    assert.equal(f.confirmations.length, 1, "the pending confirmation must block duplicate interactions")
    confirm(false)
    await ui.waitForFrame((frame) => !hasSpinner(frame))
    assert.equal(f.calls.length, 0)
  } finally { await ui.dispose() }
})

test("mode controls handle cancellation, failed switches, and repeated clicks while busy", async () => {
  const { f, ui, click, active, position } = await modeFixture()
  try {
    f.confirm = async () => false
    await click("headed")
    await ui.waitForFrame((frame) => !hasSpinner(frame))
    assert.equal(f.calls.length, 0)
    assert.deepEqual(active(), ["headless"])
    f.confirm = async () => true
    let fail!: () => void
    f.change = () => new Promise<void>((_resolve, reject) => { fail = () => reject({ message: "Permission denied" }) })
    const button = position()
    await click("headed")
    await ui.waitForFrame(hasSpinner)
    await ui.mockMouse.click(button.x, button.y)
    assert.equal(f.calls.length, 1)
    assert.equal(f.confirmations.length, 2)
    fail()
    await ui.waitForFrame((frame) => !hasSpinner(frame))
    assert.deepEqual(active(), ["headless"])
    assert.equal(f.toasts[0].message, "Permission denied")
  } finally { await ui.dispose() }
})

test("cancelling the native picker or changing sessions while it is open never switches modes", async () => {
  const { f, ui, click, setSession, active } = await modeFixture()
  try {
    f.select = async () => undefined
    await click("headed")
    await ui.waitForFrame((frame) => !hasSpinner(frame))
    assert.equal(f.confirmations.length, 0)
    assert.equal(f.calls.length, 0)
    assert.deepEqual(active(), ["headless"])
    let select!: (value: BrowserMode) => void
    f.select = () => new Promise((resolve) => { select = resolve })
    await click("headed")
    await ui.waitFor(() => f.selections.length === 2)
    await ui.renderOnce()
    assert.ok(!hasSpinner(ui.captureCharFrame()), "an open picker must not show a switching spinner")
    await click("headed")
    assert.equal(f.selections.length, 2, "repeated clicks cannot open multiple pickers")
    setSession("b")
    await ui.waitForFrame((frame) => !hasSpinner(frame))
    select("headed")
    await ui.renderOnce()
    assert.equal(f.confirmations.length, 0)
    assert.equal(f.calls.length, 0)
  } finally { await ui.dispose() }
})

test("paused browsers cannot switch modes and a session switch cancels an open confirmation", async () => {
  const { f, ui, click, setSession } = await modeFixture()
  try {
    f.snapshot = { ...f.snapshot, paused: true }
    setSession("paused")
    await ui.waitForFrame((frame) => frame.includes("paused"))
    const disabled = ui.captureSpans().lines.flatMap((line) => line.spans).find((span) => span.text.trim() === "Headless")!
    assert.ok(disabled.bg.equals(RGBA.fromHex(theme.background.action.primary.disabled)))
    assert.ok(disabled.fg.equals(RGBA.fromHex(theme.text.action.primary.disabled)))
    await click("headed")
    assert.equal(f.confirmations.length, 0)
    assert.equal(f.selections.length, 0)
    assert.equal(f.calls.length, 0)
    f.snapshot = { ...f.snapshot, paused: false }
    setSession("a")
    await ui.waitForFrame((frame) => hasModeButton(frame, "Headless") && !frame.includes("paused"))
    let confirm!: (value: boolean) => void
    f.confirm = () => new Promise((resolve) => { confirm = resolve })
    await click("headed")
    await ui.waitFor(() => f.confirmations.length === 1)
    setSession("b")
    await ui.waitForFrame((frame) => !hasSpinner(frame))
    confirm(true)
    await ui.renderOnce()
    assert.equal(f.calls.length, 0)
  } finally { await ui.dispose() }
})

test("a spinner animates only while the confirmed mode change is actually running", async () => {
  const { f, ui, click } = await modeFixture()
  let finish!: () => void
  f.change = (mode) => new Promise<void>((resolve) => {
    finish = () => { f.snapshot = { ...f.snapshot, mode }; resolve() }
  })
  try {
    assert.ok(!hasSpinner(ui.captureCharFrame()))
    await click("headed")
    const first = await ui.waitForFrame(hasSpinner)
    assert.ok(!first.includes("switching"), "the spinner replaces the text label")
    assert.ok(!first.includes("Headless") && !first.includes("Headed") && !first.includes("▾"), "only the spinner is shown instead of mode text while switching")
    await new Promise((resolve) => setTimeout(resolve, 130))
    await ui.renderOnce()
    const animated = ui.captureCharFrame()
    assert.ok(hasSpinner(animated))
    assert.notEqual(animated, first, "spinner frames must advance")
    finish()
    await ui.waitForFrame((frame) => hasModeButton(frame, "Headed") && !hasSpinner(frame))
    await new Promise((resolve) => setTimeout(resolve, 100))
    await ui.renderOnce()
    assert.ok(!hasSpinner(ui.captureCharFrame()))
  } finally { await ui.dispose() }
})

test("failed metadata reads show an unavailable state instead of silently hiding the sidebar", async () => {
  const { f, ui, setSession } = await modeFixture()
  try {
    f.failRead = true
    setSession("disconnected")
    const unavailable = await ui.waitForFrame((frame) => frame.includes("Browser connection unavailable"))
    assert.match(unavailable, /Browser use/)
    assert.ok(!hasModeButton(unavailable, "Headless"), "mode controls must not offer actions with unknown state")
    assert.ok(!unavailable.includes("Flows"), "stale tab metadata must not remain visible")
    f.failRead = false
    setSession("a")
    const recovered = await ui.waitForFrame((frame) => hasModeButton(frame, "Headless"))
    assert.match(recovered, /Flows/)
    assert.ok(!recovered.includes("unavailable"))
  } finally { await ui.dispose() }
})

test("the mode button stays on the title row in a narrow sidebar and its padding is clickable", async () => {
  const { f, ui, position } = await modeFixture()
  try {
    ui.resize(26, 12)
    const frame = await ui.waitForFrame((frame) => frame.includes("Headless"))
    assert.equal(frame.split("\n").filter((line) => line.includes("Headless")).length, 1)
    assert.equal(frame.split("\n").findIndex((line) => line.includes("Headless")), frame.split("\n").findIndex((line) => line.trim().length > 0), "the button must not wrap below the title")
    const { x, y } = position()
    await ui.mockMouse.click(x - 2, y)
    await ui.waitFor(() => f.selections.length === 1)
    assert.equal(f.selections[0].current, "headless")
  } finally { await ui.dispose() }
})

test("the mode button highlights on hover without opening the picker", async () => {
  const { f, ui, position } = await modeFixture()
  try {
    const background = () => ui.captureSpans().lines.flatMap((line) => line.spans).find((span) => span.text.trim() === "Headless")!.bg
    const before = background()
    assert.ok(before.equals(RGBA.fromHex(theme.background.action.primary.focused)), "use the filled highlight even when the normal action background is transparent")
    const label = ui.captureSpans().lines.flatMap((line) => line.spans).find((span) => span.text.trim() === "Headless")!
    assert.ok(label.fg.equals(RGBA.fromHex(theme.text.action.primary.focused)), "use its matching foreground for contrast")
    const { x, y } = position()
    await ui.mockMouse.moveTo(x, y)
    await ui.renderOnce()
    assert.notDeepEqual(background(), before)
    assert.ok(background().equals(RGBA.fromHex(theme.increase(theme.background.action.primary.focused))))
    assert.equal(f.selections.length, 0)
    await ui.mockMouse.moveTo(0, 0)
    await ui.renderOnce()
    assert.deepEqual(background(), before)
  } finally { await ui.dispose() }
})
