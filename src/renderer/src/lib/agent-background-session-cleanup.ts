export function runBestEffortAgentBackgroundCleanups(...actions: (() => void)[]): void {
  for (const action of actions) {
    try {
      action()
    } catch {
      // Preserve the launch/setup error that triggered cleanup.
    }
  }
}
