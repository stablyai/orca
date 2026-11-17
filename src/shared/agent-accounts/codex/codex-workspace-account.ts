import {
  assignWorkspaceAccount,
  workspaceAccountId,
  workspaceAccountKey,
  type WorkspaceAccountAssignment
} from '../workspace-account-binding'

export const codexWorkspaceAccountKey = workspaceAccountKey
export const codexWorkspaceAccountId = workspaceAccountId
export type CodexWorkspaceAccountAssignment = WorkspaceAccountAssignment

export function assignCodexWorkspaceAccount(
  settings: {
    codexWorkspaceAccounts?: Record<string, string>
    codexManagedAccounts?: readonly { id: string }[]
  },
  assignment: CodexWorkspaceAccountAssignment
): Record<string, string> {
  return assignWorkspaceAccount(
    settings.codexWorkspaceAccounts,
    settings.codexManagedAccounts,
    assignment,
    'Codex'
  )
}
