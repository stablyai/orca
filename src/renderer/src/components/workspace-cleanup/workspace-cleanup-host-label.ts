import { translate } from '@/i18n/i18n'
import type { Translate } from '@/i18n/use-translate'
import { getExecutionHostLabel } from '../../../../shared/execution-host'
import type { WorkspaceCleanupCandidate } from '../../../../shared/workspace-cleanup/workspace-cleanup'
import './workspace-cleanup-host-identity'
import { resolveWorkspaceCleanupRemovalHostId } from '../../../../shared/workspace-cleanup/workspace-cleanup-host-identity'

export function getWorkspaceCleanupCandidateHostLabel(
  candidate: WorkspaceCleanupCandidate,
  t: Translate = translate
): string {
  const hostId = resolveWorkspaceCleanupRemovalHostId(candidate)
  return hostId
    ? getExecutionHostLabel(hostId)
    : t('components.workspace.cleanup.host.unknown', 'Unknown host')
}

export function getWorkspaceCleanupCandidateAccessibleName(
  candidate: WorkspaceCleanupCandidate,
  t: Translate = translate
): string {
  return t('components.workspace.cleanup.host.candidateName', '{{value0}} on {{value1}}', {
    value0: candidate.displayName,
    value1: getWorkspaceCleanupCandidateHostLabel(candidate, t)
  })
}
