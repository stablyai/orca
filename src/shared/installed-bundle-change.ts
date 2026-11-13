/** Whether the app bundle on disk still matches the one this process launched from. */
export type InstalledBundleChange = {
  changed: boolean
  /** Version this process launched with; null on hosts without an app bundle (web client). */
  runningVersion: string | null
  /** Version now installed on disk; null when it cannot be read. */
  installedVersion: string | null
}
