import { usePlugin } from "@opencode/plugin/tui"
import type { Context } from "@opencode/plugin/tui/context"
import { createEffect, createSignal, onCleanup } from "solid-js"
import type { BrowserVisibility } from "./policy"
import type { BrowserMode } from "./router"
import { BrowserUse, type PagesSnapshot } from "./rpc"
import { SettingsDialog, type SettingsChoice } from "./settings"
import { createComponent } from "solid-js"

export interface VisibilityView { sessionID: string; location: Context["location"]; signal: AbortSignal }

/** One user interaction shared by the command and sidebar, never an agent tool. */
export function createVisibility(context: Context) {
  const browser = context.client.rpc(BrowserUse)
  const [operation, setOperation] = createSignal<{ view: VisibilityView; switching: boolean }>()
  return {
    busy: () => !!operation(),
    switching: (sessionID: string) => operation()?.view.sessionID === sessionID && !!operation()?.switching,
    async settings(view: VisibilityView, snapshot: PagesSnapshot) {
      if (view.signal.aborted || operation()) return
      setOperation({ view, switching: false })
      const cancel = () => { if (operation()?.view === view) setOperation(undefined) }
      view.signal.addEventListener("abort", cancel, { once: true })
      let selection: SettingsChoice | undefined
      try {
        selection = await new Promise<SettingsChoice | undefined>((resolve) => {
          let settled = false
          const finish = (choice?: SettingsChoice) => { if (!settled) { settled = true; view.signal.removeEventListener("abort", abort); resolve(choice) } }
          const abort = () => { context.ui.dialog.clear(); finish() }
          view.signal.addEventListener("abort", abort, { once: true })
          context.ui.dialog.set({ size: "large", centered: true })
          context.ui.dialog.show(() => createComponent(SettingsDialog, { snapshot, choose: (choice) => { finish(choice); context.ui.dialog.clear() } }), () => finish())
        })
      } finally { view.signal.removeEventListener("abort", cancel); cancel() }
      if (view.signal.aborted) return
      if (selection?.kind === "mode") return this.chooseMode(view, selection.value, snapshot)
      if (selection?.kind === "visibility") return this.choose(view, selection.value, snapshot)
    },
    async chooseMode(view: VisibilityView, requested?: BrowserMode, initial?: PagesSnapshot) {
      if (view.signal.aborted || operation()) return
      const cancel = () => { if (operation()?.view === view) setOperation(undefined) }
      setOperation({ view, switching: false })
      view.signal.addEventListener("abort", cancel, { once: true })
      try {
        const options = { location: view.location, signal: view.signal }
        const snapshot = initial ?? await browser.pages({ sessionID: view.sessionID }, options) as PagesSnapshot
        if (snapshot.paused) throw new Error("Finish the browser login or recovery before switching mode")
        const mode = requested ?? await context.ui.dialog.select<BrowserMode>({
          title: "Browser mode", current: snapshot.mode ?? "shared",
          options: [
            { title: "Shared", value: "shared", description: "Plugin Chrome and profile shared across sessions" },
            { title: "Isolated", value: "isolated", description: "Private persistent Chrome profile for this session" },
            { title: "Attach", value: "attach", description: "Attach to your running Chrome with remote debugging enabled" },
          ],
        })
        if (!mode || view.signal.aborted) return
        if (mode === (snapshot.mode ?? "shared")) return snapshot
        const message = [
          ...(mode === "attach" || snapshot.mode === "attach"
            ? ["This closes all browser tabs owned by this session. Their contents and handles will not be restored."]
            : ["This reopens this session's HTTP(S) tabs in the other profile, preserving page handles. Reopening URLs can cause server-side effects. Other URLs become blank tabs. Unsaved state and snapshots are lost; take fresh snapshots.", "Profiles, cookies, and authentication remain separate."]),
          "Other sessions are unaffected.",
          ...(mode === "attach" ? ["To attach, enable chrome://inspect/#remote-debugging and approve Chrome's connection requests."] : []),
        ].join("\n\n")
        const approved = await context.ui.dialog.confirm({ title: `Switch browser mode to ${mode}?`, message, label: { confirm: "Switch", cancel: "Cancel" } })
        if (!approved || view.signal.aborted) return
        setOperation({ view, switching: true })
        await browser.setMode({ sessionID: view.sessionID, mode }, options)
        return await browser.pages({ sessionID: view.sessionID }, options) as PagesSnapshot
      } catch (error) {
        if (!view.signal.aborted) context.ui.toast.show({ title: "Browser mode change failed", variant: "error", message: error instanceof Error ? error.message : "Could not change browser mode." })
      } finally {
        view.signal.removeEventListener("abort", cancel)
        cancel()
      }
    },
    async choose(view: VisibilityView, requested?: BrowserVisibility, initial?: PagesSnapshot) {
      if (view.signal.aborted || operation()) return
      const cancel = () => { if (operation()?.view === view) setOperation(undefined) }
      setOperation({ view, switching: false })
      view.signal.addEventListener("abort", cancel, { once: true })
      try {
        const options = { location: view.location, signal: view.signal }
        const snapshot = initial ?? await browser.pages({ sessionID: view.sessionID }, options) as PagesSnapshot
        if (view.signal.aborted) return
        if (snapshot.mode === "attach") throw new Error("Visibility is controlled in your own Chrome")
        // An explicit command may retry a failed restoration. The backend still
        // rejects every visibility change during a human login handoff.
        if (snapshot.paused && !requested) throw new Error("Browser automation is paused. Finish the login handoff, or use /browser-use visibility headless or headed to retry a failed visibility change.")
        const visibility = requested ?? await context.ui.dialog.select<BrowserVisibility>({
          title: "Browser visibility",
          current: snapshot.visibility ?? "headless",
          options: [
            { title: "Headless", value: "headless", description: "Run Chrome in the background" },
            { title: "Headed", value: "headed", description: "Show Chrome while automation continues" },
          ],
        })
        if (!visibility || view.signal.aborted) return
        if (snapshot.visibility === visibility && !snapshot.paused) return snapshot
        const approved = await context.ui.dialog.confirm({
          title: `Switch Chrome to ${visibility}?`,
          message: snapshot.mode === "isolated" ? "This reloads this session's tabs. Unsaved page state and snapshots will be lost. Automation will remain enabled." : "This affects the shared browser and reloads every session's tabs. Unsaved page state and snapshots will be lost. Automation will remain enabled.",
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
    mode: "global",
    commands: [{
      id: "browser-use.visibility",
      title: "Browser use settings",
      description: "Change browser mode or visibility for this session",
      slash: { name: "browser-use", arguments: true },
      run: async (input) => {
        const text = input?.trim() ?? ""
        const current = view
        if (!text) {
          if (!current || current.signal.aborted) {
            context.ui.toast.show({ message: "Open a session before changing browser settings.", variant: "error" })
            return
          }
          try {
            const snapshot = await context.client.rpc(BrowserUse).pages({ sessionID: current.sessionID }, { location: current.location, signal: current.signal }) as PagesSnapshot
            if (!current.signal.aborted) await props.visibility.settings(current, snapshot)
          } catch (error) {
            if (!current.signal.aborted) context.ui.toast.show({ title: "Browser settings unavailable", variant: "error", message: error instanceof Error ? error.message : "Could not load browser settings." })
          }
          return
        }
        const args = text.split(/\s+/)
        if (args.length > 2 || (args[0] === "visibility" ? args[1] !== undefined && args[1] !== "headless" && args[1] !== "headed" : args[0] === "mode" ? args[1] !== undefined && !["shared", "isolated", "attach"].includes(args[1]) : true)) {
          context.ui.toast.show({ message: "Usage: /browser-use visibility [headless|headed] or /browser-use mode [shared|isolated|attach]", variant: "error" })
          return
        }
        if (!current || current.signal.aborted) {
          context.ui.toast.show({ message: "Open a session before changing browser visibility.", variant: "error" })
          return
        }
        const snapshot = args[0] === "mode" ? await props.visibility.chooseMode(current, args[1] as BrowserMode | undefined) : await props.visibility.choose(current, args[1] as BrowserVisibility | undefined)
        if (snapshot && !current.signal.aborted) context.ui.toast.show({ message: args[0] === "mode" ? `Browser mode: ${snapshot.mode ?? "shared"}` : `Browser visibility: ${snapshot.visibility}`, variant: "success" })
      },
    }],
  }))
  return null
}
