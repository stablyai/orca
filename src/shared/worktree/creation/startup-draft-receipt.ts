/** The setup wrapper's verdict, or unknown if Orca lost its output. */
export type StartupDraftOutcome = 'started' | 'not-delivered' | 'unknown' | 'cleared'

export type StartupDraftReceipt = {
  id: string
  worktreeId: string
}

export type AvailableStartupDraft = StartupDraftReceipt & {
  outcome: Extract<StartupDraftOutcome, 'not-delivered' | 'unknown'>
}
