import { normalizeWorkspaceSessionKeyToWorkspaceId } from '../workspace/identity/workspace-scope'

export type WorkspaceAccountAssignment = { workspaceId: string; accountId: string | null }
export const workspaceAccountKey = normalizeWorkspaceSessionKeyToWorkspaceId
export const WORKSPACE_SYSTEM_DEFAULT_ACCOUNT_ID = 'system-default'

export function workspaceAccountId(
  bindings: Record<string, string> | undefined,
  workspaceId: string | undefined
): string | undefined {
  if (!workspaceId || !bindings) {
    return undefined
  }
  const key = workspaceAccountKey(workspaceId)
  return Object.hasOwn(bindings, key) ? bindings[key] : undefined
}

export function assignWorkspaceAccount(
  bindings: Record<string, string> | undefined,
  accounts: readonly { id: string }[] | undefined,
  assignment: WorkspaceAccountAssignment,
  provider: string
): Record<string, string> {
  if (
    assignment.accountId !== null &&
    assignment.accountId !== WORKSPACE_SYSTEM_DEFAULT_ACCOUNT_ID &&
    !accounts?.some((account) => account.id === assignment.accountId)
  ) {
    throw new Error(`That ${provider} account no longer exists on this host.`)
  }
  const next = { ...bindings }
  const key = workspaceAccountKey(assignment.workspaceId)
  if (assignment.accountId === null) {
    delete next[key]
  } else {
    next[key] = assignment.accountId
  }
  return next
}
