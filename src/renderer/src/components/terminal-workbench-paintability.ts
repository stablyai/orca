export type TerminalWorkbenchPaintabilityState = {
  isWorkbenchVisible: boolean
  hasMobileDrivenBrowser: boolean
}

export type TerminalWorkbenchPaintMode = 'visible' | 'paintable-hidden' | 'parked'

// Why: Chromium never paints inside a display:none subtree, so parking the
// workbench that way also kills screencast frames for browser pages a phone is
// driving — the pane-level paintability escape hatch cannot override an
// ancestor. Keep the workbench composited (out of flow, invisible, inert)
// whenever a mobile client is driving one of its pages.
export function resolveTerminalWorkbenchPaintMode({
  isWorkbenchVisible,
  hasMobileDrivenBrowser
}: TerminalWorkbenchPaintabilityState): TerminalWorkbenchPaintMode {
  if (isWorkbenchVisible) {
    return 'visible'
  }
  return hasMobileDrivenBrowser ? 'paintable-hidden' : 'parked'
}

export const TERMINAL_WORKBENCH_CLASS_NAMES: Record<TerminalWorkbenchPaintMode, string> = {
  visible: 'flex flex-1 min-w-0 min-h-0',
  // Why: absolute keeps the invisible workbench out of the flex column so the
  // active page (Settings, Tasks, …) still gets the full content area.
  'paintable-hidden': 'absolute inset-0 flex opacity-0 pointer-events-none',
  parked: 'hidden flex-1 min-w-0 min-h-0'
}
