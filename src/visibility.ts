import { usePlugin } from "@opencode/plugin/tui"
import type { Context } from "@opencode/plugin/tui/context"
import { createEffect, createSignal, onCleanup } from "solid-js"
import type { BrowserVisibility } from "./policy"
import { BrowserUse, type PagesSnapshot } from "./rpc"

export interface VisibilityView { sessionID: string; location: Context["location"]; signal: AbortSignal }

/** One user interaction shared by the command and sidebar, never an agent tool. */
export function createVisibility(context: Context) {
  const browser = context.client.rpc(BrowserUse)
  const [operation, setOperation] = createSignal<{ view: VisibilityView; switching: boolean }>()
  return {
    busy: () => !!operation(),
    switching: (sessionID: string) => operation()?.view.sessionID === sessionID && !!operation()?.switching,
    async choose(view: VisibilityView, requested?: BrowserVisibility, initial?: PagesSnapshot) {
      if (view.signal.aborted || operation()) return
      const cancel = () => { if (operation()?.view === view) setOperation(undefined) }
      setOperation({ view, switching: false })
      view.signal.addEventListener("abort", cancel, { once: true })
      try {
        const options = { location: view.location, signal: view.signal }
        const snapshot = initial ?? await browser.pages({ sessionID: view.sessionID }, options) as PagesSnapshot
        if (view.signal.aborted) return
        // An explicit command may retry a failed restoration. The backend still
        // rejects every visibility change during a human login handoff.
        if (snapshot.paused && !requested) throw new Error("Browser automation is paused. Finish the login handoff, or use /browser-use visibility headless or headed to retry a failed visibility change.")
        const visibility = requested ?? await context.ui.dialog.select<BrowserVisibility>({
          title: "Browser visibility",
          current: snapshot.visibility,
          options: [
            { title: "Headless", value: "headless", description: "Run Chrome in the background" },
            { title: "Headed", value: "headed", description: "Show Chrome while automation continues" },
          ],
        })
        if (!visibility || view.signal.aborted) return
        if (snapshot.visibility === visibility && !snapshot.paused) return snapshot
        const approved = await context.ui.dialog.confirm({
          title: `Switch Chrome to ${visibility}?`,
          message: "This affects the shared browser and reloads every session's tabs. Unsaved page state and snapshots will be lost. Automation will remain enabled.",
          label: { confirm: "Switch", cancel: "Cancel" },
        })
        if (!approved || view.signal.aborted) return
        setOperation({ view, switching: true })
        await browser.setVisibility({ sessionID: view.sessionID, visibility }, options)
        const updated = await browser.pages({ sessionID: view.sessionID }, options) as PagesSnapshot
        if (!view.signal.aborted) return updated
      } catch (error) {
        if (!view.signal.aborted) context.ui.toast.show({
          title: "Browser visibility change failed", variant: "error",
          message: error instanceof Error ? error.message : typeof error === "object" && error !== null && "message" in error ? String(error.message) : "Could not change Chrome visibility.",
        })
      } finally {
        view.signal.removeEventListener("abort", cancel)
        cancel()
      }
    },
  }
}

export type Visibility = ReturnType<typeof createVisibility>

/** App-scoped so the command works even with the sidebar hidden or no open tabs. */
export function VisibilityCommands(props: { visibility: Visibility }) {
  const context = usePlugin()
  let view: VisibilityView | undefined
  createEffect(() => {
    const route = context.ui.router.current()
    const controller = new AbortController()
    view = route.type === "session" ? {
      sessionID: route.sessionID,
      location: context.data.session.get(route.sessionID)?.location ?? context.location ?? context.data.location.default(),
      signal: controller.signal,
    } : undefined
    onCleanup(() => controller.abort())
  })
  context.keymap.layer(() => ({
    commands: [{
      id: "browser-use.visibility",
      title: "Browser use visibility",
      description: "/browser-use visibility [headless|headed]",
      slash: { name: "browser-use", arguments: true },
      run: async (input) => {
        const args = input?.trim().split(/\s+/) ?? []
        if (args[0] !== "visibility" || args.length > 2 || (args[1] !== undefined && args[1] !== "headless" && args[1] !== "headed")) {
          context.ui.toast.show({ message: "Usage: /browser-use visibility [headless|headed]", variant: "error" })
          return
        }
        const current = view
        if (!current || current.signal.aborted) {
          context.ui.toast.show({ message: "Open a session before changing browser visibility.", variant: "error" })
          return
        }
        const snapshot = await props.visibility.choose(current, args[1] as BrowserVisibility | undefined)
        if (snapshot && !current.signal.aborted) context.ui.toast.show({ message: `Browser visibility: ${snapshot.visibility}`, variant: "success" })
      },
    }],
  }))
  return null
}
