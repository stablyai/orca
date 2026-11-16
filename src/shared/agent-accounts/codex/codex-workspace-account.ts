import { normalizeWorkspaceSessionKeyToWorkspaceId } from '../../workspace/identity/workspace-scope'

export function codexWorkspaceAccountKey(workspaceId: string): string {
  return normalizeWorkspaceSessionKeyToWorkspaceId(workspaceId)
}

export function codexWorkspaceAccountId(
  bindings: Record<string, string> | undefined,
  workspaceId: string | undefined
): string | undefined {
  if (!workspaceId || !bindings) {
    return undefined
  }
  const key = codexWorkspaceAccountKey(workspaceId)
  return Object.hasOwn(bindings, key) ? bindings[key] : undefined
}

export type CodexWorkspaceAccountAssignment = { workspaceId: string; accountId: string | null }

export function assignCodexWorkspaceAccount(
  settings: {
    codexWorkspaceAccounts?: Record<string, string>
    codexManagedAccounts?: readonly { id: string }[]
  },
  assignment: CodexWorkspaceAccountAssignment
): Record<string, string> {
  if (
    assignment.accountId !== null &&
    !settings.codexManagedAccounts?.some((account) => account.id === assignment.accountId)
  ) {
    throw new Error('That Codex account no longer exists on this host.')
  }
  const bindings = { ...settings.codexWorkspaceAccounts }
  const key = codexWorkspaceAccountKey(assignment.workspaceId)
  if (assignment.accountId === null) {
    delete bindings[key]
  } else {
    bindings[key] = assignment.accountId
  }
  return bindings
}
