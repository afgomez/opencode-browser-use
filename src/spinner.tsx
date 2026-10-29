import { usePlugin } from "@opencode/plugin/tui"
import { createSignal, onCleanup, onMount } from "solid-js"

export const spinnerFrames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const

/** Mounted only while busy; no animation timer survives unmount or plugin reload. */
export function Spinner() {
  const context = usePlugin()
  const [frame, setFrame] = createSignal(0)
  onMount(() => {
    const timer = setInterval(() => setFrame((index) => (index + 1) % spinnerFrames.length), 80)
    onCleanup(() => clearInterval(timer))
  })
  return <text fg={context.theme.text.muted}> {spinnerFrames[frame()]}</text>
}
