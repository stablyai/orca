export type E2EConfig = {
  enabled: boolean
  headless: boolean
  exposeStore: boolean
  userDataDir: string | null
  /** Test-only override (ORCA_E2E_TERMINAL_PARKING_DELAY_MS) shrinking the
   *  terminal hidden-view parking delays. null means use production timing. */
  terminalParkingDelayMs: number | null
}

type E2EConfigInput = {
  headless?: boolean
  exposeStore?: boolean
  userDataDir?: string | null
  terminalParkingDelayMs?: number | null
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

  return {
    enabled: headless || exposeStore || userDataDir !== null,
    headless,
    exposeStore,
    userDataDir,
    terminalParkingDelayMs
  }
}
