export function replayLayoutWithOneShotParkIntent<TRestored>(
  deps: { mountFollowsTerminalPark: boolean },
  replayLayout: () => TRestored
): TRestored {
  try {
    return replayLayout()
  } finally {
    deps.mountFollowsTerminalPark = false
  }
}
