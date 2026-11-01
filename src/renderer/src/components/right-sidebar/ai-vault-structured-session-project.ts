import type { AiVaultSession } from '../../../../shared/ai-vault-types'
import type { FolderWorkspace } from '../../../../shared/folder-workspace-types'
import { getFolderWorkspaceWorktreeHostId } from '../../../../shared/folder-workspace-worktree'
import { folderWorkspaceKey } from '../../../../shared/workspace-scope'
import { normalizeExecutionHostId, type ExecutionHostId } from '../../../../shared/execution-host'
import { toAiVaultProjectKey } from '../../../../shared/ai-vault-project-key'
import {
  folderGroupKey,
  folderLabel,
  type AiVaultSessionProject
} from '../../../../shared/ai-vault-session-filters'

type ProjectCandidate = {
  workspaceId?: string
  normalizedPath: string
  hostKey: ExecutionHostId
  projectId: string | null
  repoId: string | null
}

/** Stored chat ownership takes precedence over transcript cwd, within the same host only. */
export function resolveStructuredAiVaultSessionProject(
  session: AiVaultSession,
  candidates: readonly ProjectCandidate[],
  folderWorkspaces: readonly FolderWorkspace[],
  labels: ReadonlyMap<string, string>
): AiVaultSessionProject | null {
  const owner = session.structuredSession
  if (!owner) {
    return null
  }
  const host = normalizeExecutionHostId(session.executionHostId)
  const folder = folderWorkspaces.find(
    (workspace) =>
      folderWorkspaceKey(workspace.id) === owner.workspaceId &&
      getFolderWorkspaceWorktreeHostId(workspace) === host
  )
  if (folder) {
    return aiVaultFolderProject(folder.folderPath)
  }
  const candidate = candidates.find(
    (item) => item.workspaceId === owner.workspaceId && item.hostKey === host
  )
  return candidate ? aiVaultCandidateProject(candidate, labels) : null
}

export function aiVaultCandidateProject(
  candidate: ProjectCandidate,
  labels: ReadonlyMap<string, string>
): AiVaultSessionProject {
  const key = toAiVaultProjectKey(candidate.projectId, candidate.repoId)
  if (!key) {
    return aiVaultFolderProject(candidate.normalizedPath)
  }
  return {
    kind: 'repo',
    key,
    label: labels.get(key) ?? key,
    ...(candidate.projectId ? { projectId: candidate.projectId } : {}),
    ...(candidate.repoId ? { repoId: candidate.repoId } : {}),
    hostKey: candidate.hostKey
  }
}

export function aiVaultFolderProject(cwd: string): AiVaultSessionProject {
  return { kind: 'folder', key: folderGroupKey(cwd), label: folderLabel(cwd) }
}
