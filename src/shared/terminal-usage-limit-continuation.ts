export type TerminalUsageLimitContinuationResult =
  | { status: 'turn-started' | 'input-accepted' | 'draft' | 'unknown' }
  | {
      status: 'refused'
      reason: 'draft' | 'permission' | 'changed' | 'unavailable' | 'in-progress'
    }
