import type { ElectronApplication } from '@stablyai/playwright-test'

/** Per-launch options for `createRestartSession().launch`. */
export type LaunchOptions = {
  extraArgs?: string[]
  // Attach stderr before firstWindow so startup guard/metrics logs cannot be missed.
  onStderr?: (chunk: string) => void
  /** Merged into this launch only (not baked into the session's shared env). */
  extraEnv?: Record<string, string>
  /** Runs in the test process after main starts and before the first window resolves. */
  beforeFirstWindow?: (app: ElectronApplication) => Promise<void>
}
