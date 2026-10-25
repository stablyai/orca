import { linearStatus } from '@/runtime/runtime-linear-client'
import {
  credentialDecryptionMessage,
  isIntegrationCredentialDecryptionError
} from '../../../shared/integration-credential-errors'
import {
  findLinearIssueWorkspaceLookupIds,
  isLinearIssueUrlResolutionMatch,
  type LinearIssueUrlIntent
} from '../../../shared/linear/links'
import type { LinearIssue } from '../../../shared/linear/issue-types'
import type { LinearConnectionStatus } from '../../../shared/linear/workspace-types'
import type { TaskSourceContext } from '../../../shared/task-source-context'

type FetchLinearIssue = (
  identifier: string,
  workspaceId?: string | null,
  options?: { sourceContext?: TaskSourceContext | null }
) => Promise<LinearIssue | null>

async function fetchMatchingLinearIssue(
  intent: LinearIssueUrlIntent,
  workspaceId: string,
  sourceContext: TaskSourceContext | null,
  fetchLinearIssue: FetchLinearIssue
): Promise<LinearIssue | null> {
  try {
    const issue = await fetchLinearIssue(intent.identifier, workspaceId, { sourceContext })
    return issue && isLinearIssueUrlResolutionMatch(intent, issue) ? issue : null
  } catch (error) {
    if (isIntegrationCredentialDecryptionError(error)) {
      throw error
    }
    return null
  }
}

export async function lookupLinearIssueUrl({
  intent,
  knownStatus,
  sourceContext,
  fetchLinearIssue,
  // Why: no source context has always read this computer's Linear status.
  readLinearStatus = (context) => linearStatus(context ?? { kind: 'local' })
}: {
  intent: LinearIssueUrlIntent
  knownStatus: Pick<
    LinearConnectionStatus,
    'workspaces' | 'viewer' | 'activeWorkspaceId' | 'selectedWorkspaceId'
  >
  sourceContext: TaskSourceContext | null
  fetchLinearIssue: FetchLinearIssue
  readLinearStatus?: (sourceContext: TaskSourceContext | null) => Promise<LinearConnectionStatus>
}): Promise<LinearIssue | null> {
  const triedWorkspaceIds = new Set<string>()
  const undecryptableWorkspaceIds = new Set<string>()
  const lookupInStatus = async (
    status: Pick<
      LinearConnectionStatus,
      'workspaces' | 'viewer' | 'activeWorkspaceId' | 'selectedWorkspaceId'
    >
  ): Promise<LinearIssue | null> => {
    for (const workspaceId of findLinearIssueWorkspaceLookupIds(intent, status)) {
      if (triedWorkspaceIds.has(workspaceId)) {
        continue
      }
      triedWorkspaceIds.add(workspaceId)
      const issue = await fetchMatchingLinearIssue(
        intent,
        workspaceId,
        sourceContext,
        fetchLinearIssue
      ).catch(() => {
        undecryptableWorkspaceIds.add(workspaceId)
        return null
      })
      if (issue) {
        return issue
      }
    }
    return null
  }

  const knownIssue = await lookupInStatus(knownStatus)
  if (knownIssue) {
    return knownIssue
  }

  const currentStatus = await readLinearStatus(sourceContext).catch(() => null)
  const issue = currentStatus ? await lookupInStatus(currentStatus) : null
  // Why: a healthy workspace may still match; report the credential failure only when none did.
  if (!issue && undecryptableWorkspaceIds.size > 0) {
    throw new Error(credentialDecryptionMessage('Linear'))
  }
  return issue
}
