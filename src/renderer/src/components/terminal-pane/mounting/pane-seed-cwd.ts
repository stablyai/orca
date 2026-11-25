export function resolvePaneSeedCwd(splitPaneCwd: string | undefined, fallbackCwd: string): string {
  return splitPaneCwd ?? fallbackCwd
}
