import { createAiVaultScopeCwdMatcher } from './ai-vault-scope-cwd-match'
import { normalizeRuntimePathForComparison } from './cross-platform-path'
import type { ExecutionHostId } from './execution-host'

type Workspace = { id: string; path: string; hostId?: ExecutionHostId }
type Conversation = {
  executionHostId: ExecutionHostId
  cwd: string | null
  cwdAliases?: string[]
  filePath?: string
  structuredSession?: { workspaceId: string }
}

export function createConversationWorkspaceMatcher<T extends Workspace>(workspaces: readonly T[]) {
  const candidates = workspaces
    .map((workspace) => ({
      workspace,
      length: normalizeRuntimePathForComparison(workspace.path).length,
      contains: createAiVaultScopeCwdMatcher([workspace.path])
    }))
    .sort((a, b) => b.length - a.length)
  return (session: Conversation): T | null => {
    const matches = candidates.filter(
      ({ workspace, contains }) =>
        (workspace.hostId ?? 'local') === session.executionHostId &&
        (session.structuredSession
          ? workspace.id === session.structuredSession.workspaceId
          : [session.cwd, ...(session.cwdAliases ?? [])].some((cwd) =>
              contains(cwd, session.filePath)
            ))
    )
    const best = matches[0]
    return best &&
      !matches.some(
        (candidate) =>
          candidate.length === best.length && candidate.workspace.id !== best.workspace.id
      )
      ? best.workspace
      : null
  }
}
