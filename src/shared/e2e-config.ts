export type E2EConfig = {
  enabled: boolean
  headless: boolean
  exposeStore: boolean
  userDataDir: string | null
  /** Test-only override (ORCA_E2E_TERMINAL_PARKING_DELAY_MS) shrinking the
   *  terminal hidden-view parking delays. null means use production timing. */
  terminalParkingDelayMs: number | null
  /** Test-only override (ORCA_E2E_TERMINAL_RETENTION_LIMIT) shrinking the
   *  hidden un-parkable worktree force-park budget. null means production (12). */
  terminalRetentionLimit: number | null
}

type E2EConfigInput = {
  headless?: boolean
  exposeStore?: boolean
  userDataDir?: string | null
  terminalParkingDelayMs?: number | null
  terminalRetentionLimit?: number | null
}

export function createE2EConfig(input: E2EConfigInput): E2EConfig {
  const userDataDir = input.userDataDir?.trim() || null
  const headless = Boolean(input.headless)
  const exposeStore = Boolean(input.exposeStore)
  const terminalParkingDelayMs =
    typeof input.terminalParkingDelayMs === 'number' &&
    Number.isFinite(input.terminalParkingDelayMs) &&
    input.terminalParkingDelayMs > 0
      ? input.terminalParkingDelayMs
      : null
  // Why: pane-weight units — only a positive integer is a meaningful budget.
  const terminalRetentionLimit =
    typeof input.terminalRetentionLimit === 'number' &&
    Number.isInteger(input.terminalRetentionLimit) &&
    input.terminalRetentionLimit > 0
      ? input.terminalRetentionLimit
      : null

  return {
    enabled: headless || exposeStore || userDataDir !== null,
    headless,
    exposeStore,
    userDataDir,
    terminalParkingDelayMs,
    terminalRetentionLimit
  }
}
