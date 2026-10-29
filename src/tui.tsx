import { Plugin, usePlugin } from "@opencode/plugin/tui"
import { createEffect, createSignal, For, onCleanup, Show } from "solid-js"
import { BrowserUse, emptySnapshot, type PagesSnapshot } from "./rpc"
import type { BrowserMode } from "./policy"
import { singleLine, watchPages } from "./sidebar"
import { Spinner } from "./spinner"

export function BrowserSidebar(props: { sessionID: string }) {
  const context = usePlugin()
  const browser = context.client.rpc(BrowserUse)
  const [snapshot, setSnapshot] = createSignal<PagesSnapshot>(emptySnapshot())
  const [busy, setBusy] = createSignal(false)
  const [switching, setSwitching] = createSignal(false)
  const [unavailable, setUnavailable] = createSignal(false)
  const [modeHovered, setModeHovered] = createSignal(false)
  // The filled control style is "focused"; base/selected may be transparent.
  // This is visual styling only and does not steal keyboard focus.
  const modeButtonState = () => ({ disabled: busy() || snapshot().paused, focused: true })
  const modeButtonBackground = () => {
    const state = modeButtonState()
    const color = context.theme.background.action.primary.state(state)
    return modeHovered() && !state.disabled ? context.theme.increase(color) : color
  }
  let view: { sessionID: string; location: typeof context.location; signal: AbortSignal } | undefined
  createEffect(() => {
    const sessionID = props.sessionID
    const location = context.data.session.get(sessionID)?.location ?? context.location ?? context.data.location.default()
    const controller = new AbortController()
    view = { sessionID, location, signal: controller.signal }
    setSnapshot(emptySnapshot())
    setBusy(false)
    setSwitching(false)
    setUnavailable(false)
    const stop = watchPages(
      async (signal) => await browser.pages({ sessionID }, { location, signal }) as PagesSnapshot,
      (value) => { if (!busy()) { setSnapshot(value); setUnavailable(false) } },
      1000,
      () => { if (!busy()) setUnavailable(true) },
    )
    onCleanup(() => { controller.abort(); stop() })
  })

  async function chooseMode() {
    const current = view
    if (!current || current.signal.aborted || unavailable() || busy() || snapshot().paused) return
    setBusy(true)
    try {
      const mode = await context.ui.dialog.select<BrowserMode>({
        title: "Browser mode",
        current: snapshot().mode,
        options: [
          { title: "Headless", value: "headless", description: "Run Chrome in the background" },
          { title: "Headed", value: "headed", description: "Show Chrome while automation continues" },
        ],
      })
      if (!mode || current.signal.aborted || snapshot().paused || snapshot().mode === mode) return
      const approved = await context.ui.dialog.confirm({
        title: `Switch Chrome to ${mode}?`,
        message: "This affects the shared browser and reloads every session's tabs. Unsaved page state and snapshots will be lost. Automation will remain enabled.",
        label: { confirm: "Switch", cancel: "Cancel" },
      })
      if (!approved || current.signal.aborted) return
      setSwitching(true)
      await browser.switchMode({ sessionID: current.sessionID, mode }, { location: current.location, signal: current.signal })
      const updated = await browser.pages({ sessionID: current.sessionID }, { location: current.location, signal: current.signal }) as PagesSnapshot
      if (!current.signal.aborted) setSnapshot(updated)
    } catch (error) {
      if (!current.signal.aborted) context.ui.toast.show({
        title: "Browser mode switch failed", variant: "error",
        message: error instanceof Error ? error.message : typeof error === "object" && error !== null && "message" in error ? String(error.message) : "Could not switch Chrome mode.",
      })
    } finally {
      if (!current.signal.aborted) { setSwitching(false); setBusy(false) }
    }
  }
  return (
    <Show when={snapshot().pages.length > 0 || unavailable()}>
      <box flexDirection="column" gap={1} paddingTop={1} flexShrink={0}>
        <box flexDirection="column">
          <box flexDirection="row" gap={1} justifyContent="space-between">
            <text fg={context.theme.text.base} width={0} flexGrow={1} flexShrink={1} minWidth={0} height={1} wrapMode="none" truncate>
              <strong>Browser use<Show when={!unavailable()}> · {snapshot().pages.length} {snapshot().pages.length === 1 ? "tab" : "tabs"}</Show></strong>
            </text>
            <Show when={!unavailable()}>
              <box flexDirection="row" flexShrink={0}>
                <Show when={switching()} fallback={<>
                <box
                  backgroundColor={modeButtonBackground()}
                  paddingLeft={1} paddingRight={1} height={1} flexShrink={0}
                  onMouseOver={() => setModeHovered(true)}
                  onMouseOut={() => setModeHovered(false)}
                  // Open after release, so the opening click cannot dismiss the dialog.
                  onMouseUp={(event) => { if (event.button === 0) { event.stopPropagation(); void chooseMode() } }}
                >
                  <text fg={context.theme.text.action.primary.state(modeButtonState())}>
                    <strong>{snapshot().mode === "headless" ? "Headless" : "Headed"}</strong> ▾
                  </text>
                </box>
                <Show when={snapshot().paused}><text fg={context.theme.text.muted}> (paused)</text></Show>
                </>}>
                  <Spinner />
                </Show>
              </box>
            </Show>
          </box>
          <Show when={unavailable()}>
            <text fg={context.theme.text.muted}>Browser connection unavailable; retrying…</text>
          </Show>
        </box>
        <For each={snapshot().pages}>{(page) => (
          <box flexDirection="column" flexShrink={0} paddingLeft={2}>
            <text fg={context.theme.text.base} height={1} wrapMode="none" truncate content={singleLine(page.title) || "Untitled"} />
            <text fg={context.theme.text.muted} height={1} wrapMode="none" truncate content={singleLine(page.url)} />
          </box>
        )}</For>
      </box>
    </Show>
  )
}

export default Plugin.define({
  id: "browser-use",
  setup(context) {
    return context.ui.slot({
      append: "sidebar.content",
      render: (input) => <BrowserSidebar sessionID={input.sessionID} />,
    })
  },
})
