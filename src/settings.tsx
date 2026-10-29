import { usePlugin } from "@opencode/plugin/tui"
import { useKeyboard } from "@opentui/solid"
import { createSignal, For, Show } from "solid-js"
import type { PagesSnapshot } from "./rpc"
import type { BrowserMode } from "./router"
import type { BrowserVisibility } from "./policy"

export type SettingsChoice = { kind: "mode"; value: BrowserMode } | { kind: "visibility"; value: BrowserVisibility }

export function SettingsDialog(props: { snapshot: PagesSnapshot; choose: (choice: SettingsChoice) => void }) {
  const context = usePlugin()
  const modes: Array<{ title: string; choice: SettingsChoice }> = [
    { title: "Shared", choice: { kind: "mode", value: "shared" } },
    { title: "Isolated", choice: { kind: "mode", value: "isolated" } },
    { title: "Attach", choice: { kind: "mode", value: "attach" } },
  ]
  const visibility: Array<{ title: string; choice: SettingsChoice }> = [
    { title: "Headless", choice: { kind: "visibility", value: "headless" } },
    { title: "Headed", choice: { kind: "visibility", value: "headed" } },
  ]
  // Keyboard navigation traverses the two visible groups in display order.
  const choices = () => props.snapshot.mode === "attach" ? modes : [...modes, ...visibility]
  const [index, setIndex] = createSignal(0)
  useKeyboard((event) => {
    if (event.name === "up" || event.name === "down" || event.name === "tab") {
      event.preventDefault()
      const delta = event.name === "up" || (event.name === "tab" && event.shift) ? -1 : 1
      setIndex((index() + delta + choices().length) % choices().length)
    } else if (event.name === "return") {
      event.preventDefault()
      props.choose(choices()[Math.min(index(), choices().length - 1)].choice)
    }
  })
  const row = (item: { title: string; choice: SettingsChoice }, position: () => number) => (
    <box
      backgroundColor={index() === position() ? context.theme.background.action.primary.state({ focused: true }) : undefined}
      onMouseOver={() => setIndex(position())}
      onMouseUp={(event) => { if (event.button === 0) { event.stopPropagation(); props.choose(item.choice) } }}
    >
      <text fg={index() === position() ? context.theme.text.action.primary.state({ focused: true }) : context.theme.text.base}>
        {item.choice.kind === "mode" ? (props.snapshot.mode ?? "shared") === item.choice.value ? "  ◉  " : "  ◯  " : props.snapshot.visibility === item.choice.value ? "  ◉  " : "  ◯  "}{item.title}
      </text>
    </box>
  )
  return <box flexDirection="column" paddingBottom={1} paddingLeft={2} paddingRight={2} gap={1}>
    <box flexDirection="row" justifyContent="space-between">
      <text fg={context.theme.text.base}><strong>Browser settings</strong></text>
      <text fg={context.theme.text.muted}>esc</text>
    </box>
    <box flexDirection="column">
      <text fg={context.theme.text.muted}>The settings affect the <strong>current session</strong> only.</text>
    </box>
    <box flexDirection="column">
      <text fg={context.theme.background.action.primary.state({ focused: true })}><strong>Mode</strong></text>
      <text fg={context.theme.text.muted}>Choose which browser this session uses.</text>
      <box height={1} />
      <For each={modes}>{(item, i) => row(item, i)}</For>
      <Show when={props.snapshot.mode !== "attach"}>
          <box height={1} />
          <text fg={context.theme.background.action.primary.state({ focused: true })}><strong>Visibility</strong></text>
          <text fg={context.theme.text.muted}>Choose whether Chrome is visible.</text>
          <box height={1} />
          <For each={visibility}>{(item, i) => row(item, () => modes.length + i())}</For>
      </Show>
    </box>
    <box height={1} />
    <text fg={context.theme.text.muted}>↑↓ / Tab navigate   Enter select</text>
  </box>
}
