import { Plugin, usePlugin } from "@opencode/plugin/tui"
import { createEffect, createSignal, For, onCleanup, Show } from "solid-js"
import { BrowserUse, emptySnapshot, type PagesSnapshot } from "./rpc"
import { singleLine, watchPages } from "./sidebar"
import { Spinner } from "./spinner"
import { createVisibility, VisibilityCommands, type Visibility, type VisibilityView } from "./visibility"

export function BrowserSidebar(props: { sessionID: string; visibility?: Visibility }) {
  const context = usePlugin()
  const browser = context.client.rpc(BrowserUse)
  const [snapshot, setSnapshot] = createSignal<PagesSnapshot>(emptySnapshot())
  const visibility = props.visibility ?? createVisibility(context)
  const busy = visibility.busy
  const switching = () => visibility.switching(props.sessionID)
  const [unavailable, setUnavailable] = createSignal(false)
  const [visibilityHovered, setVisibilityHovered] = createSignal(false)
  // The filled control style is "focused"; base/selected may be transparent.
  // This is visual styling only and does not steal keyboard focus.
  const visibilityButtonState = () => ({ disabled: busy() || snapshot().paused, focused: true })
  const visibilityButtonBackground = () => {
    const state = visibilityButtonState()
    const color = context.theme.background.action.primary.state(state)
    return visibilityHovered() && !state.disabled ? context.theme.increase(color) : color
  }
  let view: VisibilityView | undefined
  createEffect(() => {
    const sessionID = props.sessionID
    const location = context.data.session.get(sessionID)?.location ?? context.location ?? context.data.location.default()
    const controller = new AbortController()
    view = { sessionID, location, signal: controller.signal }
    setSnapshot(emptySnapshot())
    setUnavailable(false)
    const stop = watchPages(
      async (signal) => await browser.pages({ sessionID }, { location, signal }) as PagesSnapshot,
      (value) => { if (!busy()) { setSnapshot(value); setUnavailable(false) } },
      1000,
      () => { if (!busy()) setUnavailable(true) },
    )
    onCleanup(() => { controller.abort(); stop() })
  })

  async function chooseVisibility() {
    const current = view
    if (!current || current.signal.aborted || unavailable() || busy() || snapshot().paused) return
    const updated = await visibility.choose(current, undefined, snapshot())
    if (updated && !current.signal.aborted) setSnapshot(updated)
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
                  backgroundColor={visibilityButtonBackground()}
                  paddingLeft={1} paddingRight={1} height={1} flexShrink={0}
                  onMouseOver={() => setVisibilityHovered(true)}
                  onMouseOut={() => setVisibilityHovered(false)}
                  // Open after release, so the opening click cannot dismiss the dialog.
                  onMouseUp={(event) => { if (event.button === 0) { event.stopPropagation(); void chooseVisibility() } }}
                >
                  <text fg={context.theme.text.action.primary.state(visibilityButtonState())}>
                    <strong>{snapshot().visibility === "headless" ? "Headless" : "Headed"}</strong> ▾
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
    const visibility = createVisibility(context)
    const commands = context.ui.slot({
      append: "app",
      render: () => <VisibilityCommands visibility={visibility} />,
    })
    const sidebar = context.ui.slot({
      append: "sidebar.content",
      render: (input) => <BrowserSidebar sessionID={input.sessionID} visibility={visibility} />,
    })
    return () => { commands(); sidebar() }
  },
})
