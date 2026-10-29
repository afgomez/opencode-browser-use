import assert from "node:assert/strict"
import { test } from "node:test"
import { testRender } from "@opentui/solid"
import { PluginContextProvider } from "@opencode/plugin/tui"
import type { Context, KeymapCommand, KeymapLayer, Route, SlotClaim } from "@opencode/plugin/tui/context"
import { createSignal, Show, type JSX } from "solid-js"
import { RGBA, TextAttributes } from "@opentui/core"
import tui, { BrowserSidebar } from "../src/tui"
import { emptySnapshot, type PagesSnapshot } from "../src/rpc"
import type { BrowserVisibility } from "../src/policy"
import type { BrowserMode } from "../src/router"
import { spinnerFrames } from "../src/spinner"
import { createVisibility, VisibilityCommands, type Visibility } from "../src/visibility"
import { SettingsDialog } from "../src/settings"

const hasSpinner = (frame: string) => spinnerFrames.some((glyph) => frame.includes(glyph))
const hasVisibilityButton = (frame: string, visibility: "Headless" | "Headed") => frame.split("\n").some((line) => line.includes("Browser use") && line.includes("Settings")) && frame.includes(`Shared / ${visibility}`)
const actionColor = (base: string, hovered: string, disabled: string, focused = base) => ({
  base, hovered, disabled, focused,
  state: (states: { disabled?: boolean; hovered?: boolean; focused?: boolean }) => states.disabled ? disabled : states.focused ? focused : states.hovered ? hovered : base,
})
const theme = {
  text: { base: "#ffffff", muted: "#888888", action: { primary: actionColor("#111111", "#222222", "#999999"), secondary: actionColor("#aaaaaa", "#ffffff", "#888888") } },
  background: { action: { primary: actionColor("#7799ff", "#5577dd", "#333333", "#88aaff"), secondary: actionColor("#00000000", "#333333", "#00000000") } },
  markdown: { heading: "#bb88ff" },
  increase: (color: string) => color === "#88aaff" ? "#aaccff" : color,
}

test("the TUI entrypoint appends disposable command and sidebar contributions", async () => {
  const claims: SlotClaim[] = []
  let disposed = 0
  const cleanup = await tui.setup({
    client: { rpc() { return {} } },
    ui: { slot(input: SlotClaim) { claims.push(input); return () => { disposed++ } } },
  } as unknown as Context)
  assert.deepEqual(claims.map((claim) => claim.append), ["app", "sidebar.content"])
  assert.ok(claims.every((claim) => typeof claim.render === "function"))
  assert.ok(cleanup)
  await cleanup()
  assert.equal(disposed, 2)
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
    assert.ok(hasVisibilityButton(frame, "Headless"), "the visibility button belongs on the title row")
    assert.ok(!frame.includes("[ Settings ]"), "the button should not have text brackets")
    assert.ok(!frame.includes("Visibility:"))
    assert.ok(frame.includes("Shared / Headless"), "the state appears below the title")
    assert.ok(!frame.includes("long-path/".repeat(5)), "long URLs must not wrap onto extra lines")
    assert.deepEqual(calls[0].location, { directory: "/workspace/a" })
    setSession("b")
    const loading = await ui.waitForFrame((frame) => !frame.includes("Flows"))
    assert.ok(loading.includes("Browser use") && loading.includes("Settings"))
    assert.equal(calls[0].signal.aborted, true)
    assert.deepEqual(calls.at(-1)!.location, { directory: "/workspace/b" })
    finishB({ ...emptySnapshot(), pages: [{ pageId: "b1", title: "Only session B", url: "https://b.test/" }] })
    const next = await ui.waitForFrame((frame) => frame.includes("Only session B"))
    assert.match(next, /Browser use · 1 tab/)
    assert.ok(!next.includes("Flows"))
    setSession("empty")
    const empty = await ui.waitForFrame((frame) => !frame.includes("Only session B"))
    assert.ok(empty.includes("Browser use") && empty.includes("Settings"))
    assert.match(empty, /0 tabs/)
  } finally {
    await ui.dispose()
  }
  assert.equal(calls.at(-1)!.signal.aborted, true)
})

test("sidebar polling updates titles/URLs and keeps settings when the last tab closes", async () => {
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
    current = { ...emptySnapshot(), visibility: "headed", pages: [{ pageId: "a", title: "After", url: "https://after.test/" }] }
    await new Promise((resolve) => setTimeout(resolve, 1100))
    const changed = await ui.waitForFrame((frame) => frame.includes("After"))
    assert.match(changed, /https:\/\/after.test\//)
    assert.ok(changed.includes("Shared / Headed"), "external visibility changes must update the state")
    current = emptySnapshot()
    await new Promise((resolve) => setTimeout(resolve, 1100))
    const empty = await ui.waitForFrame((frame) => !frame.includes("After"))
    assert.ok(empty.includes("Browser use") && empty.includes("Settings"))
    assert.match(empty, /0 tabs/)
  } finally { await ui.dispose() }
})

test("sidebar shows mode and applicable visibility beneath the title", async () => {
  let current: PagesSnapshot = { mode: "isolated", visibility: "headed", paused: false, pages: [{ pageId: "a", title: "Tab", url: "https://example.test/" }] }
  const [session, setSession] = createSignal("a")
  const context = {
    client: { rpc() { return { async pages() { return current } } } },
    data: { session: { get() { return { location: { directory: "/workspace" } } } } },
    theme,
  } as unknown as Context
  const ui = await testRender(() => <PluginContextProvider value={context}><BrowserSidebar sessionID={session()} /></PluginContextProvider>, { width: 40, height: 10 })
  try {
    const isolated = await ui.waitForFrame((frame) => frame.includes("Isolated / Headed"))
    assert.ok(isolated.split("\n").findIndex((line) => line.includes("Isolated / Headed")) > isolated.split("\n").findIndex((line) => line.includes("Browser use")))
    current = { ...current, mode: "attach", visibility: null }
    setSession("b")
    const user = await ui.waitForFrame((frame) => frame.split("\n").some((line) => line.trim() === "Attach"))
    assert.ok(!user.includes(" / Head"))
  } finally { await ui.dispose() }
})

test("an empty sidebar keeps working settings for mode and visibility changes", async () => {
  const { f, ui, click, setSession, visibility } = await visibilityFixture()
  try {
    f.snapshot = { ...emptySnapshot(), mode: "shared" }
    setSession("empty")
    const empty = await ui.waitForFrame((frame) => frame.includes("0 tabs") && !frame.includes("Flows"))
    assert.ok(hasVisibilityButton(empty, "Headless"))
    await click("headed")
    await ui.waitForFrame((frame) => hasVisibilityButton(frame, "Headed"))
    assert.equal(f.calls.at(-1)!.visibility, "headed")
    assert.match(ui.captureCharFrame(), /0 tabs/)
    visibility.settings = (view, snapshot) => visibility.chooseMode(view, "isolated", snapshot)
    await click("headed")
    await ui.waitForFrame((frame) => frame.includes("Isolated / Headless"))
    assert.deepEqual(f.modeCalls, ["isolated"])
    assert.match(ui.captureCharFrame(), /0 tabs/)
  } finally { await ui.dispose() }
})

async function visibilityFixture(options: { commands?: boolean; sidebar?: boolean } = {}) {
  const [session, setSession] = createSignal("a")
  let command!: KeymapCommand
  let layer!: KeymapLayer
  let visibility!: Visibility
  const f = {
    snapshot: { ...emptySnapshot(), pages: [{ pageId: "a", title: "Flows", url: "https://a.test/" }] },
    confirmations: [] as Array<{ title: string; message: string }>,
    selections: [] as Array<{ title: string; current: BrowserVisibility; options: Array<{ title: string; value: BrowserVisibility }> }>,
    calls: [] as Array<{ sessionID: string; visibility: BrowserVisibility; location: { directory: string }; signal: AbortSignal }>,
    toasts: [] as Array<{ message: string }>,
    failRead: false,
    selected: "headed" as BrowserVisibility,
    settingsChoice: "visibility" as "visibility" | "mode" | undefined,
    settingsOptions: [] as string[],
    modeCalls: [] as BrowserMode[],
    select: async () => f.selected as BrowserVisibility | undefined,
    confirm: async () => true as boolean | undefined,
    change: async (_visibility: BrowserVisibility) => {},
  }
  f.change = async (visibility) => { f.snapshot = { ...f.snapshot, visibility } }
  const context = {
    keymap: { layer(factory: () => KeymapLayer) { layer = factory(); command = layer.commands![0] } },
    client: { rpc() { return {
      async pages() { if (f.failRead) throw new Error("Chrome disconnected"); return f.snapshot },
      async setVisibility(input: { sessionID: string; visibility: BrowserVisibility }, options: { location: { directory: string }; signal: AbortSignal }) {
        f.calls.push({ ...input, ...options })
        await f.change(input.visibility)
        return {}
      },
      async setMode(input: { sessionID: string; mode: BrowserMode }) { f.modeCalls.push(input.mode); f.snapshot = { ...f.snapshot, mode: input.mode, visibility: input.mode === "attach" ? null : "headless", pages: [] }; return {} },
    } } },
    data: { session: { get(id: string) { return { location: { directory: `/workspace/${id}` } } } } },
    theme,
    ui: {
      router: { current: (): Route => session() === "home" ? { type: "home" } : { type: "session", sessionID: session() } },
      dialog: {
        async select(input: (typeof f.selections)[number]) { if (input.title === "Browser settings") { f.settingsOptions = input.options.map((option) => option.value); return f.settingsChoice }; f.selections.push(input); return f.select() },
        async confirm(input: { title: string; message: string }) { f.confirmations.push(input); return f.confirm() },
      },
      toast: { show(input: { message: string }) { f.toasts.push(input) } },
    },
  } as unknown as Context
  const ui = await testRender(() => {
    visibility = createVisibility(context)
    // Exercise the sidebar interaction separately from the dialog's own renderer.
    visibility.settings = async (view, snapshot) => {
      const choice = await context.ui.dialog.select<"mode" | "visibility">({ title: "Browser settings", options: [
        { title: "Mode", value: "mode" }, ...(snapshot.mode === "attach" ? [] : [{ title: "Visibility", value: "visibility" as const }]),
      ] })
      if (view.signal.aborted) return
      if (choice === "mode") return visibility.chooseMode(view, undefined, snapshot)
      if (choice === "visibility") return visibility.choose(view, undefined, snapshot)
    }
    return <PluginContextProvider value={context}>
      {options.commands ? <VisibilityCommands visibility={visibility} /> : null}
      {options.sidebar === false ? null : <BrowserSidebar sessionID={session()} visibility={visibility} />}
    </PluginContextProvider>
  }, { width: 45, height: 12 })
  if (options.sidebar !== false) await ui.waitForFrame((frame) => hasVisibilityButton(frame, "Headless"))
  else await ui.renderOnce()
  const position = () => {
    const lines = ui.captureCharFrame().split("\n")
    const y = lines.findIndex((line) => line.includes("Settings"))
    assert.ok(y >= 0)
    return { x: lines[y].indexOf("Settings") + 1, y }
  }
  const click = async (visibility: BrowserVisibility) => {
    f.selected = visibility
    const { x, y } = position()
    await ui.mockMouse.click(x, y)
  }
  const active = () => ui.captureCharFrame().includes("Shared / Headless") ? ["headless"] : ui.captureCharFrame().includes("Shared / Headed") ? ["headed"] : []
  return { f, ui, click, active, setSession, position, command, layer, visibility }
}

test("visibility command accepts both settings without a sidebar or tabs and skips the picker", async () => {
  const { f, ui, command, layer } = await visibilityFixture({ commands: true, sidebar: false })
  try {
    assert.equal(command.id, "browser-use.visibility")
    assert.equal(command.title, "Browser use settings")
    assert.equal(command.description, "Change browser mode or visibility for this session")
    assert.equal(layer.mode, "global", "slash completion must work while the prompt owns input")
    assert.deepEqual(command.slash, { name: "browser-use", arguments: true })
    f.snapshot = emptySnapshot()
    for (const visibility of ["headed", "headless"] as const) {
      await command.run(`visibility ${visibility}`)
      assert.equal(f.calls.at(-1)!.visibility, visibility)
      assert.equal(f.calls.at(-1)!.sessionID, "a")
      assert.deepEqual(f.calls.at(-1)!.location, { directory: "/workspace/a" })
      assert.match(f.confirmations.at(-1)!.message, /every session's tabs/)
      assert.equal(f.toasts.at(-1)!.message, `Browser visibility: ${visibility}`)
    }
    assert.equal(f.confirmations.length, 2)
    assert.equal(f.selections.length, 0)
    await command.run("visibility headless")
    assert.equal(f.calls.length, 2, "already-selected visibility must not restart Chrome or confirm")
    assert.equal(f.confirmations.length, 2)
  } finally { await ui.dispose() }
})

test("custom settings renders choices and selects with keyboard; User hides visibility", async () => {
  const [user, setUser] = createSignal(false)
  const choices: string[] = []
  const context = { theme } as unknown as Context
  const ui = await testRender(() => <PluginContextProvider value={context}>
    <SettingsDialog snapshot={{ ...emptySnapshot(), mode: user() ? "attach" : "shared", visibility: user() ? null : "headless" }} choose={(choice) => choices.push(`${choice.kind}:${choice.value}`)} />
  </PluginContextProvider>, { width: 60, height: 22 })
  try {
    const frame = await ui.waitForFrame((frame) => frame.includes("Browser settings") && frame.includes("Headless"))
    assert.ok(frame.includes("The settings affect the current session only."))
    const sessionText = ui.captureSpans().lines.flatMap((line) => line.spans).find((span) => span.text === "current session")
    assert.ok(sessionText && (sessionText.attributes & TextAttributes.BOLD), "current session should be emphasized")
    assert.ok(frame.includes("Shared") && frame.includes("Isolated") && frame.includes("Attach") && frame.includes("Headed"))
    assert.match(frame, /◉\s+Shared/)
    assert.match(frame, /◉\s+Headless/)
    for (const heading of ["Mode", "Visibility"]) {
      const span = ui.captureSpans().lines.flatMap((line) => line.spans).find((span) => span.text.trim() === heading)
      assert.ok(span && (span.attributes & TextAttributes.BOLD), `${heading} should use heading styling`)
    }
    await ui.mockInput.pressArrow("down")
    await ui.mockInput.pressEnter()
    assert.deepEqual(choices, ["mode:isolated"])
    const lines = ui.captureCharFrame().split("\n")
    const headed = lines.findIndex((line) => line.includes("Headed"))
    await ui.mockMouse.click(lines[headed].indexOf("Headed") + 1, headed)
    assert.deepEqual(choices, ["mode:isolated", "visibility:headed"])
    setUser(true)
    const userFrame = await ui.waitForFrame((frame) => frame.includes("Attach") && !frame.includes("Headless"))
    assert.ok(!userFrame.includes("Visibility"))
  } finally { await ui.dispose() }
})

test("custom settings applies a selection through confirmation and closes on session abort", async () => {
  const [dialog, setDialog] = createSignal<(() => JSX.Element) | undefined>()
  let closed: (() => void) | undefined
  let calls = 0
  const context = {
    theme,
    client: { rpc() { return { async pages() { return { ...emptySnapshot(), visibility: "headed", mode: "shared" } }, async setVisibility() { calls++; return {} } } } },
    ui: { dialog: {
      set() {},
      show(render: () => JSX.Element, onClose: () => void) { closed = onClose; setDialog(() => render) },
      clear() { setDialog(undefined); const callback = closed; closed = undefined; callback?.() },
      async confirm() { return true },
    }, toast: { show() {} } },
  } as unknown as Context
  const ui = await testRender(() => <PluginContextProvider value={context}><Show when={dialog()}>{(render) => render()()}</Show></PluginContextProvider>, { width: 60, height: 22 })
  try {
    const visibility = createVisibility(context)
    const controller = new AbortController()
    const view = { sessionID: "a", location: { directory: "/workspace" }, signal: controller.signal }
    const changing = visibility.settings(view, { ...emptySnapshot(), mode: "shared" })
    await ui.waitForFrame((frame) => frame.includes("Headed"))
    for (let i = 0; i < 4; i++) await ui.mockInput.pressArrow("down")
    await ui.mockInput.pressEnter()
    await changing
    assert.equal(calls, 1)
    assert.equal(dialog(), undefined)
    const dismissed = visibility.settings(view, { ...emptySnapshot(), mode: "shared" })
    const frame = await ui.waitForFrame((frame) => frame.includes("Browser settings"))
    const lines = frame.split("\n")
    const y = lines.findIndex((line) => line.includes("esc"))
    await ui.mockMouse.click(lines[y].indexOf("esc") + 1, y)
    await dismissed
    assert.equal(dialog(), undefined)
    assert.equal(visibility.busy(), false)
    assert.equal(calls, 1, "dismissal must not change settings")
    const cancelled = visibility.settings(view, { ...emptySnapshot(), mode: "shared" })
    await ui.waitForFrame((frame) => frame.includes("Browser settings"))
    controller.abort()
    await cancelled
    assert.equal(dialog(), undefined)
    assert.equal(calls, 1)
  } finally { await ui.dispose() }
})

test("mode command requires confirmation, changes only the requested session, and supports no-op", async () => {
  const { f, ui, command } = await visibilityFixture({ commands: true, sidebar: false })
  try {
    f.confirm = async () => false
    await command.run("mode isolated")
    assert.deepEqual(f.modeCalls, [])
    assert.match(f.confirmations[0].message, /preserving page handles/)
    assert.match(f.confirmations[0].message, /server-side effects/)
    assert.match(f.confirmations[0].message, /cookies, and authentication remain separate/)
    assert.match(f.confirmations[0].message, /\n\nOther sessions/)
    assert.doesNotMatch(f.confirmations[0].message, /remote-debugging|In Attach mode/)
    f.confirm = async () => true
    await command.run("mode isolated")
    assert.deepEqual(f.modeCalls, ["isolated"])
    assert.equal(f.toasts.at(-1)!.message, "Browser mode: isolated")
    await command.run("mode isolated")
    assert.deepEqual(f.modeCalls, ["isolated"])
    await command.run("mode attach")
    assert.match(f.confirmations.at(-1)!.message, /closes all browser tabs owned by this session/)
    assert.match(f.confirmations.at(-1)!.message, /\n\nTo attach/)
    assert.match(f.confirmations.at(-1)!.message, /chrome:\/\/inspect\/#remote-debugging/)
    assert.doesNotMatch(f.confirmations.at(-1)!.message, /last tab/)
  } finally { await ui.dispose() }
})

test("browser settings hides visibility in Attach mode", async () => {
  const { f, ui, visibility } = await visibilityFixture({ sidebar: false })
  try {
    f.settingsChoice = undefined
    const controller = new AbortController()
    await visibility.settings({ sessionID: "a", location: { directory: "/workspace/a" }, signal: controller.signal }, { ...emptySnapshot(), mode: "attach", visibility: null })
    assert.deepEqual(f.settingsOptions, ["mode"])
  } finally { await ui.dispose() }
})

test("visibility command without a value uses the picker and supports cancellation", async () => {
  const { f, ui, command } = await visibilityFixture({ commands: true })
  try {
    f.select = async () => undefined
    await command.run("visibility")
    assert.equal(f.selections.length, 1)
    assert.equal(f.confirmations.length, 0)
    f.select = async () => "headed"
    f.confirm = async () => false
    await command.run("  visibility   ")
    assert.equal(f.selections[1].current, "headless")
    assert.equal(f.confirmations.length, 1)
    assert.equal(f.calls.length, 0)
    f.confirm = async () => true
    await command.run("visibility")
    assert.equal(f.calls[0].visibility, "headed")
  } finally { await ui.dispose() }
})

test("bare browser-use opens session settings and reports read failures", async () => {
  const { f, ui, command, setSession } = await visibilityFixture({ commands: true, sidebar: false })
  try {
    f.settingsChoice = undefined
    await command.run()
    assert.deepEqual(f.settingsOptions, ["mode", "visibility"])
    assert.equal(f.toasts.length, 0)
    f.snapshot = { ...emptySnapshot(), mode: "attach", visibility: null }
    await command.run("   ")
    assert.deepEqual(f.settingsOptions, ["mode"])
    f.failRead = true
    await command.run()
    assert.equal(f.toasts.at(-1)!.message, "Chrome disconnected")
    setSession("home")
    await ui.renderOnce()
    await command.run()
    assert.match(f.toasts.at(-1)!.message, /Open a session/)
  } finally { await ui.dispose() }
})

test("visibility command rejects invalid arguments and home-route calls without browser effects", async () => {
  const { f, ui, command, setSession } = await visibilityFixture({ commands: true, sidebar: false })
  try {
    for (const input of ["headed", "visibility visible", "visibility headed extra", "visibility headless\nanything"]) {
      await command.run(input)
      assert.equal(f.toasts.at(-1)!.message, "Usage: /browser-use visibility [headless|headed] or /browser-use mode [shared|isolated|attach]")
    }
    setSession("home")
    await ui.renderOnce()
    await command.run("visibility headed")
    assert.match(f.toasts.at(-1)!.message, /Open a session/)
    assert.equal(f.calls.length, 0)
    assert.equal(f.confirmations.length, 0)
    assert.equal(f.selections.length, 0)
  } finally { await ui.dispose() }
})

test("command and sidebar share busy state and show only the spinner during a confirmed command switch", async () => {
  const { f, ui, command, click, visibility } = await visibilityFixture({ commands: true })
  let confirm!: (value: boolean) => void
  let finish!: () => void
  f.confirm = () => new Promise((resolve) => { confirm = resolve })
  f.change = (visibility) => new Promise<void>((resolve) => { finish = () => { f.snapshot = { ...f.snapshot, visibility }; resolve() } })
  try {
    const changing = command.run("visibility headed")
    await ui.waitFor(() => f.confirmations.length === 1)
    assert.ok(visibility.busy())
    assert.ok(!hasSpinner(ui.captureCharFrame()))
    await click("headed")
    await command.run("visibility headed")
    assert.equal(f.confirmations.length, 1)
    assert.equal(f.selections.length, 0)
    confirm(true)
    const frame = await ui.waitForFrame(hasSpinner)
    assert.ok(!frame.includes("Settings") && frame.includes("Shared / Headless"))
    finish()
    await changing
    await ui.waitForFrame((frame) => !hasSpinner(frame))
    assert.equal(f.calls.length, 1)
    assert.ok(!visibility.busy())
    await new Promise((resolve) => setTimeout(resolve, 1100))
    await ui.waitForFrame((frame) => hasVisibilityButton(frame, "Headed"))
  } finally { await ui.dispose() }
})

test("changing sessions or unmounting cancels a command waiting for confirmation", async () => {
  for (const unmount of [false, true]) {
    const { f, ui, command, setSession, visibility } = await visibilityFixture({ commands: true, sidebar: false })
    let confirm!: (value: boolean) => void
    f.confirm = () => new Promise((resolve) => { confirm = resolve })
    try {
      const changing = command.run("visibility headed")
      await ui.waitFor(() => f.confirmations.length === 1)
      if (unmount) await ui.dispose()
      else { setSession("b"); await ui.renderOnce() }
      confirm(true)
      await changing
      assert.equal(f.calls.length, 0)
      assert.ok(!visibility.busy())
      assert.equal(f.toasts.length, 0)
    } finally { if (!unmount) await ui.dispose() }
  }
})

test("command failures show a toast and explicit visibility settings allow restoration retries", async () => {
  const { f, ui, command } = await visibilityFixture({ commands: true, sidebar: false })
  try {
    f.failRead = true
    await command.run("visibility headed")
    assert.equal(f.toasts.at(-1)!.message, "Chrome disconnected")
    assert.equal(f.calls.length, 0)
    f.failRead = false
    f.snapshot = { ...emptySnapshot(), paused: true }
    f.change = async () => { throw new Error("Browser automation is paused for human login") }
    await command.run("visibility headless")
    assert.equal(f.calls.length, 1, "same-visibility recovery must reach backend, which still rejects a login pause")
    assert.match(f.toasts.at(-1)!.message, /paused for human login/)
    f.change = async (visibility) => { f.snapshot = { ...f.snapshot, visibility, paused: false } }
    await command.run("visibility headless")
    assert.equal(f.calls.length, 2)
    assert.equal(f.toasts.at(-1)!.message, "Browser visibility: headless")
  } finally { await ui.dispose() }
})

test("visibility controls highlight the current value and confirm clicks before switching either direction", async () => {
  const { f, ui, click, active } = await visibilityFixture()
  try {
    assert.deepEqual(active(), ["headless"])
    await click("headless")
    assert.equal(f.confirmations.length, 0, "choosing the current visibility is a no-op")
    assert.equal(f.selections[0].current, "headless")
    assert.deepEqual(f.selections[0].options.map((option) => option.value), ["headless", "headed"])
    for (const visibility of ["headed", "headless"] as const) {
      await click(visibility)
      await ui.waitForFrame((frame) => hasVisibilityButton(frame, visibility === "headed" ? "Headed" : "Headless") && !hasSpinner(frame))
      assert.equal(f.calls.at(-1)!.visibility, visibility)
      assert.equal(f.selections.at(-1)!.title, "Browser visibility")
      assert.deepEqual(f.calls.at(-1)!.location, { directory: "/workspace/a" })
      assert.equal(f.calls.at(-1)!.sessionID, "a")
      assert.match(f.confirmations.at(-1)!.message, /every session's tabs/)
      assert.deepEqual(active(), [visibility])
    }
    assert.equal(f.confirmations.length, 2)
  } finally { await ui.dispose() }
})

test("the opening click finishes before showing the confirmation and leaves it pending for user input", async () => {
  const { f, ui, position } = await visibilityFixture()
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

test("visibility controls handle cancellation, failed switches, and repeated clicks while busy", async () => {
  const { f, ui, click, active, position } = await visibilityFixture()
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

test("cancelling the native picker or changing sessions while it is open never changes visibility", async () => {
  const { f, ui, click, setSession, active } = await visibilityFixture()
  try {
    f.select = async () => undefined
    await click("headed")
    await ui.waitForFrame((frame) => !hasSpinner(frame))
    assert.equal(f.confirmations.length, 0)
    assert.equal(f.calls.length, 0)
    assert.deepEqual(active(), ["headless"])
    let select!: (value: BrowserVisibility) => void
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

test("paused browsers cannot change visibility and a session switch cancels an open confirmation", async () => {
  const { f, ui, click, setSession } = await visibilityFixture()
  try {
    f.snapshot = { ...f.snapshot, paused: true }
    setSession("paused")
    await ui.waitForFrame((frame) => frame.includes("paused"))
    const disabled = ui.captureSpans().lines.flatMap((line) => line.spans).find((span) => span.text.trim() === "Settings")!
    assert.ok(disabled.bg.equals(RGBA.fromHex("#00000000")))
    assert.ok(disabled.fg.equals(RGBA.fromHex(theme.text.action.secondary.disabled)))
    await click("headed")
    assert.equal(f.confirmations.length, 0)
    assert.equal(f.selections.length, 0)
    assert.equal(f.calls.length, 0)
    f.snapshot = { ...f.snapshot, paused: false }
    setSession("a")
    await ui.waitForFrame((frame) => hasVisibilityButton(frame, "Headless") && !frame.includes("paused"))
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

test("a spinner animates only while the confirmed visibility change is actually running", async () => {
  const { f, ui, click } = await visibilityFixture()
  let finish!: () => void
  f.change = (visibility) => new Promise<void>((resolve) => {
    finish = () => { f.snapshot = { ...f.snapshot, visibility }; resolve() }
  })
  try {
    assert.ok(!hasSpinner(ui.captureCharFrame()))
    await click("headed")
    const first = await ui.waitForFrame(hasSpinner)
    assert.ok(!first.includes("switching"), "the spinner replaces the text label")
    assert.ok(!first.includes("Settings") && first.includes("Shared / Headless"), "the spinner replaces the button while the state remains visible")
    await new Promise((resolve) => setTimeout(resolve, 130))
    await ui.renderOnce()
    const animated = ui.captureCharFrame()
    assert.ok(hasSpinner(animated))
    assert.notEqual(animated, first, "spinner frames must advance")
    finish()
    await ui.waitForFrame((frame) => hasVisibilityButton(frame, "Headed") && !hasSpinner(frame))
    await new Promise((resolve) => setTimeout(resolve, 100))
    await ui.renderOnce()
    assert.ok(!hasSpinner(ui.captureCharFrame()))
  } finally { await ui.dispose() }
})

test("failed metadata reads retain a disabled Settings button and clear stale metadata", async () => {
  const { f, ui, setSession, click } = await visibilityFixture()
  try {
    f.failRead = true
    setSession("disconnected")
    const unavailable = await ui.waitForFrame((frame) => frame.includes("Browser connection unavailable"))
    assert.match(unavailable, /Browser use/)
    assert.match(unavailable, /Settings/)
    const disabled = ui.captureSpans().lines.flatMap((line) => line.spans).find((span) => span.text.trim() === "Settings")!
    assert.ok(disabled.bg.equals(RGBA.fromHex("#00000000")))
    await click("headed")
    assert.equal(f.selections.length, 0, "settings cannot open with unknown state")
    assert.equal(f.calls.length, 0)
    assert.ok(!hasVisibilityButton(unavailable, "Headless"), "unknown visibility must not be shown")
    assert.ok(!unavailable.includes("Flows"), "stale tab metadata must not remain visible")
    f.failRead = false
    setSession("a")
    const recovered = await ui.waitForFrame((frame) => hasVisibilityButton(frame, "Headless"))
    assert.match(recovered, /Flows/)
    assert.ok(!recovered.includes("unavailable"))
  } finally { await ui.dispose() }
})

test("the visibility button stays on the title row in a narrow sidebar and its padding is clickable", async () => {
  const { f, ui, position } = await visibilityFixture()
  try {
    ui.resize(26, 12)
    const frame = await ui.waitForFrame((frame) => frame.includes("Headless"))
    assert.equal(frame.split("\n").filter((line) => line.includes("Headless")).length, 1)
    assert.equal(frame.split("\n").findIndex((line) => line.includes("Settings")), frame.split("\n").findIndex((line) => line.trim().length > 0), "the button must not wrap below the title")
    const { x, y } = position()
    await ui.mockMouse.click(x - 2, y)
    await ui.waitFor(() => f.selections.length === 1)
    assert.equal(f.selections[0].current, "headless")
  } finally { await ui.dispose() }
})

test("the visibility button highlights on hover without opening the picker", async () => {
  const { f, ui, position } = await visibilityFixture()
  try {
    const background = () => ui.captureSpans().lines.flatMap((line) => line.spans).find((span) => span.text.trim() === "Settings")!.bg
    const before = background()
    assert.ok(before.equals(RGBA.fromHex(theme.background.action.secondary.base)), "the resting button uses the secondary action color")
    const label = ui.captureSpans().lines.flatMap((line) => line.spans).find((span) => span.text.trim() === "Settings")!
    assert.ok(label.fg.equals(RGBA.fromHex(theme.text.action.secondary.base)), "use the secondary action text color")
    const { x, y } = position()
    await ui.mockMouse.moveTo(x, y)
    await ui.renderOnce()
    assert.notDeepEqual(background(), before)
    assert.ok(background().equals(RGBA.fromHex(theme.background.action.secondary.hovered)))
    assert.equal(f.selections.length, 0)
    await ui.mockMouse.moveTo(0, 0)
    await ui.renderOnce()
    assert.deepEqual(background(), before)
  } finally { await ui.dispose() }
})
