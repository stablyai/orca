export type MissingWorktreeTerminalTeardownResult = {
  stoppedWorktreeIds: string[]
  /** Absent on legacy hosts; present IDs were physically verified exited. */
  verifiedStoppedWorktreeIds?: string[]
}
