import type {
  SourceControlPrimaryActionDecision,
  SourceControlPrimaryActionDecisionInputs
} from './source-control-primary-action-decision-types'

export function resolveSourceControlPrimaryActionDuringRemoteOp(
  inputs: SourceControlPrimaryActionDecisionInputs,
  resolveWithoutRemoteOp: (
    inputs: SourceControlPrimaryActionDecisionInputs
  ) => SourceControlPrimaryActionDecision
): SourceControlPrimaryActionDecision {
  const { inFlightRemoteOpKind, hasUnresolvedConflicts } = inputs
  const candidate = resolveWithoutRemoteOp({ ...inputs, isRemoteOperationActive: false })
  const inFlightIsPrimaryKind =
    inFlightRemoteOpKind === 'push' ||
    inFlightRemoteOpKind === 'pull' ||
    inFlightRemoteOpKind === 'sync' ||
    inFlightRemoteOpKind === 'publish'

  if (inFlightRemoteOpKind === 'force_push') {
    return {
      kind: 'push',
      labelIntent: 'force_push',
      titleIntent: 'force_push_in_progress',
      disabled: true,
      requiresForceWithLease: true
    }
  }

  if (inFlightIsPrimaryKind && candidate.kind !== inFlightRemoteOpKind) {
    return {
      kind: inFlightRemoteOpKind,
      labelIntent: inFlightRemoteOpKind,
      titleIntent: 'action_in_progress',
      disabled: true
    }
  }

  const titleIntent = hasUnresolvedConflicts
    ? 'resolve_conflicts_before_commit'
    : candidate.kind === 'commit'
      ? 'remote_operation_blocks_commit'
      : 'remote_operation_in_progress'

  return {
    ...candidate,
    titleIntent,
    disabled: true
  }
}
