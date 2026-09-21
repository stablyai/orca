import { translate } from '@/i18n/i18n'
import { getExecutionHostLabel } from '../../../../shared/execution-host'
import type { WorkspaceCleanupCandidate } from '../../../../shared/workspace-cleanup'
import { resolveWorkspaceCleanupRemovalHostId } from './workspace-cleanup-host-identity'

export function getWorkspaceCleanupCandidateHostLabel(
  candidate: WorkspaceCleanupCandidate
): string {
  const hostId = resolveWorkspaceCleanupRemovalHostId(candidate)
  return hostId
    ? getExecutionHostLabel(hostId)
    : translate('components.workspace.cleanup.host.unknown', 'Unknown host')
}

export function getWorkspaceCleanupCandidateAccessibleName(
  candidate: WorkspaceCleanupCandidate
): string {
  return translate('components.workspace.cleanup.host.candidateName', '{{value0}} on {{value1}}', {
    value0: candidate.displayName,
    value1: getWorkspaceCleanupCandidateHostLabel(candidate)
  })
}
