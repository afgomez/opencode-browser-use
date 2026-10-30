import { Plugin, usePlugin } from "@opencode/plugin/tui"
import { createEffect, createSignal, For, onCleanup, Show } from "solid-js"
import { BrowserUse, emptySnapshot, type PagesSnapshot } from "./rpc"
import { singleLine, watchPages } from "./sidebar"
import { Spinner } from "./spinner"
import { createSettings, SettingsCommands, type Settings, type SettingsView } from "./browser-settings"

export function BrowserSidebar(props: { sessionID: string; settings?: Settings }) {
  const context = usePlugin()
  const browser = context.client.rpc(BrowserUse)
  const [snapshot, setSnapshot] = createSignal<PagesSnapshot>(emptySnapshot())
  const settings = props.settings ?? createSettings(context)
  const busy = settings.busy
  const switching = () => settings.switching(props.sessionID)
  const [unavailable, setUnavailable] = createSignal(false)
  const [settingsHovered, setSettingsHovered] = createSignal(false)
  const settingsButtonState = () => ({ disabled: unavailable() || busy() || snapshot().paused, hovered: settingsHovered() })
  const settingsButtonBackground = () => context.theme.background.action.secondary.state(settingsButtonState())
  const settingsButtonText = () => context.theme.text.action.secondary.state(settingsButtonState())
  let view: SettingsView | undefined
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

  async function chooseSettings() {
    const current = view
    if (!current || current.signal.aborted || unavailable() || busy() || snapshot().paused) return
    const updated = await settings.settings(current, snapshot())
    if (updated && !current.signal.aborted) setSnapshot(updated)
  }
  return (
    <box flexDirection="column" gap={1} flexShrink={0}>
      <box flexDirection="column">
        <text fg={context.theme.text.base} height={1} wrapMode="none" truncate>
          <strong>Browser use<Show when={!unavailable()}> · {snapshot().pages.length} {snapshot().pages.length === 1 ? "tab" : "tabs"}</Show></strong>
        </text>
        <box flexDirection="row" gap={1} justifyContent="space-between">
          <text fg={context.theme.text.muted} width={0} flexGrow={1} flexShrink={1} minWidth={0} height={1} wrapMode="none" truncate>
            <Show when={!unavailable()} fallback={<>Browser connection unavailable; retrying…</>}>
              {snapshot().mode === "attach" ? "Attach" : snapshot().mode === "isolated" ? "Isolated" : "Shared"}
              <Show when={snapshot().mode !== "attach" && snapshot().visibility}> / {snapshot().visibility === "headless" ? "Headless" : "Headed"}</Show>
            </Show>
          </text>
          <box flexDirection="row" flexShrink={0}>
            <Show when={switching()} fallback={<>
              <box
                backgroundColor={settingsButtonBackground()}
                paddingLeft={1} paddingRight={1} height={1} flexShrink={0}
                onMouseOver={() => setSettingsHovered(true)}
                onMouseOut={() => setSettingsHovered(false)}
                // Open after release, so the opening click cannot dismiss the dialog.
                onMouseUp={(event) => { if (event.button === 0) { event.stopPropagation(); void chooseSettings() } }}
              >
                <text fg={settingsButtonText()}>
                  <strong>Settings</strong>
                </text>
              </box>
              <Show when={snapshot().paused}><text fg={context.theme.text.muted}> (paused)</text></Show>
            </>}>
              <Spinner />
            </Show>
          </box>
        </box>
      </box>
      <For each={snapshot().pages}>{(page) => (
        <box flexDirection="column" flexShrink={0} paddingLeft={2}>
          <text fg={context.theme.text.base} height={1} wrapMode="none" truncate content={singleLine(page.title) || "Untitled"} />
          <text fg={context.theme.text.muted} height={1} wrapMode="none" truncate content={singleLine(page.url)} />
        </box>
      )}</For>
    </box>
  )
}

export default Plugin.define({
  id: "browser-use",
  setup(context) {
    const settings = createSettings(context)
    const commands = context.ui.slot({
      append: "app",
      render: () => <SettingsCommands settings={settings} />,
    })
    const sidebar = context.ui.slot({
      append: "sidebar.content",
      render: (input) => <BrowserSidebar sessionID={input.sessionID} settings={settings} />,
    })
    return () => { commands(); sidebar() }
  },
})
