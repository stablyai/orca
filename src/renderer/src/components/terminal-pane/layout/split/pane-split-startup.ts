export type SplitStartupPayload = { command: string; env?: Record<string, string> }

export function splitPaneWithOneShotStartup<TPane>(
  deps: { startup?: SplitStartupPayload | null },
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
