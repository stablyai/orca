import type { PtyPaneStartup } from '../../pty-connection/startup/pty-pane-startup'

type SplitStartupPayload = Pick<NonNullable<PtyPaneStartup>, 'command' | 'env'>

export function splitPaneWithOneShotStartup<TPane>(
  deps: { startup?: PtyPaneStartup },
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
