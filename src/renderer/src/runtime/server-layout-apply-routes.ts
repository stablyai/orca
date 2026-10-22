// Which workspaces a paired server's main takes layout intents for now: those its frames draw in
// this window (server-layout-frames.ts). A leaf, so the store-free sender can ask without the store.

/** A workspace a server's frames draw, as `layout.apply` reaches that server's main. */
export type ServerLayoutApplyRoute = {
  environmentId: string
  /** A desktop tab id as the server names it; null when its frames hold no such tab. */
  serverTabId: (desktopTabId: string) => string | null
  /** A server tab id under desktop ids. */
  desktopTabId: (serverTabId: string) => string
  /** Draws the workspace from the server's frames again, over whatever the window drew. */
  redraw: () => void
}

/** Whose main answered a layout intent, and whose frames show the answer. */
export type LayoutApplyOrigin = {
  /** The stream key (layout-frame-position.ts) whose frames hold the answer. */
  framesKey: string
  /** A paired server's main took it: the window never makes the change itself. */
  routed: boolean
}

export const LOCAL_LAYOUT_APPLY_ORIGIN: LayoutApplyOrigin = { framesKey: 'local', routed: false }

type RouteProvider = (worktreeId: string) => ServerLayoutApplyRoute | null

const providers = new Map<string, RouteProvider>()

export function provideServerLayoutApplyRoutes(
  environmentId: string,
  provider: RouteProvider
): () => void {
  providers.set(environmentId, provider)
  return () => {
    if (providers.get(environmentId) === provider) {
      providers.delete(environmentId)
    }
  }
}

/** Null unless the server's frames draw the workspace now. */
export function serverLayoutApplyRoute(
  environmentId: string,
  worktreeId: string
): ServerLayoutApplyRoute | null {
  return providers.get(environmentId)?.(worktreeId) ?? null
}

/** Draws a workspace from its server's frames again, over what the window drew; false when no
 *  server's frames draw it now. */
export function redrawServerLayoutWorkspace(environmentId: string, worktreeId: string): boolean {
  const route = serverLayoutApplyRoute(environmentId, worktreeId)
  route?.redraw()
  return route !== null
}
