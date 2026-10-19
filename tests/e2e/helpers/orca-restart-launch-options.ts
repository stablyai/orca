import type { ElectronApplication } from '@stablyai/playwright-test'

/** Per-launch options for `createRestartSession().launch`. */
export type LaunchOptions = {
  extraArgs?: string[]
  /**
   * Called for each chunk the relaunched main process writes to stderr. The
   * listener is attached before `firstWindow()` resolves so main-process
   * startup logs (e.g. the daemon health-check guard) can't be emitted before
   * the test starts capturing.
   */
  onStderr?: (chunk: string) => void
  /** Merged into this launch only (not baked into the session's shared env). */
  extraEnv?: Record<string, string>
  /** Runs in the test process after main starts and before the first window resolves. */
  beforeFirstWindow?: (app: ElectronApplication) => Promise<void>
}
