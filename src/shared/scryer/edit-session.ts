export type ScryerCompletionGateNextAction =
  | 'nothing_to_fold'
  | 'fold_allowed'
  | 'fix_validation'
  | 'manual_review'
  | 'blocked_by_lease'

export type ScryerCompletionGateBlocker = {
  code: 'validation_error' | 'unknown_pending_kind' | 'unknown_pending_change' | 'lease_conflict'
  message: string
  path?: string
  details?: Record<string, unknown>
}

export type ScryerCompletionGateRisk = {
  code: 'destructive_change' | 'structural_change'
  message: string
  changeId: string
  changeKind: string
}

export type ScryerPendingChangeDto = {
  kind: string
  id: string
  ownerId?: string
  label: string
  changes: Record<string, unknown>[]
}

export type ScryerValidationFindingDto = {
  code: string
  severity: 'warning' | 'error'
  message: string
  path?: string
  details?: Record<string, unknown>
}

export type ScryerCompletionGateResult = {
  ok: boolean
  foldAllowed: boolean
  nextAction: ScryerCompletionGateNextAction
  pending: {
    total: number
    foldable: boolean
    byKind: Partial<Record<string, number>>
    byChange: Partial<Record<string, number>>
    changes: ScryerPendingChangeDto[]
    blockers: ScryerCompletionGateBlocker[]
    risks: ScryerCompletionGateRisk[]
  }
  validation: {
    blockingCount: number
    warningCount: number
    findings: ScryerValidationFindingDto[]
  }
  lease: {
    active: boolean
    blocked: boolean
    owner?: 'agent' | 'human' | 'system'
    agentRunId?: string
  }
}

export type ScryerEditSessionStatus = {
  projectPath: string
  activeLease: {
    owner?: 'agent' | 'human' | 'system'
    agentRunId?: string
    createdAt?: string
    expiresAt?: string
  } | null
}
