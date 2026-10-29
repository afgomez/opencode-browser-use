import { emptySnapshot, type PagesSnapshot } from "./rpc"

/** One in-flight read at a time; stopped/session-switched readers cannot publish late results. */
export function watchPages(
  load: (signal: AbortSignal) => Promise<PagesSnapshot>,
  update: (snapshot: PagesSnapshot) => void,
  intervalMs = 1000,
  onError?: () => void,
) {
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  async function refresh() {
    try {
      const snapshot = await load(controller.signal)
      if (!controller.signal.aborted) update(snapshot)
    } catch {
      // Do not leave another session's or a disconnected browser's stale tabs visible.
      if (!controller.signal.aborted) { update(emptySnapshot()); onError?.() }
    } finally {
      if (!controller.signal.aborted) timer = setTimeout(() => { void refresh() }, intervalMs)
    }
  }
  void refresh()
  return () => { controller.abort(); clearTimeout(timer) }
}

/** Page titles/URLs are untrusted plain text, not terminal control sequences. */
export function singleLine(value: string) {
  return value.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").trim()
}
