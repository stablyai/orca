export type StatusBarMemorySettings = {
  /** Live Orca app memory beside the Resource Manager icon; off stops its sampling. */
  showStatusBarMemory?: boolean
}

export function isStatusBarMemoryShown(
  settings: StatusBarMemorySettings | null | undefined
): boolean {
  return settings?.showStatusBarMemory !== false
}
