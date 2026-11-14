import type { PtyPaneStartup } from '../../pty-connection/startup/pty-pane-startup'

export type SplitStartupPayload = { command: string; env?: Record<string, string> }

export function splitPaneWithOneShotStartup<TPane>(
  // Why the union: pane deps hold a full PtyPaneStartup, whose command is optional (#39852).
  deps: { startup?: SplitStartupPayload | PtyPaneStartup | null },
  startup: SplitStartupPayload,
  splitPane: () => TPane
): TPane {
  deps.startup = startup
  try {
    return splitPane()
  } finally {
    deps.startup = null
  }
}
