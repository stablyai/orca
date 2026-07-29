import { relativePathInsideRoot } from '../../../shared/cross-platform-path'

export type WorkspaceCandidate = { id: string; path: string }

export type ResolvedOsFileWorkspace = {
  workspace: WorkspaceCandidate
  relativePath: string
}

export function findWorkspaceForFilePath(
  filePath: string,
  candidates: readonly WorkspaceCandidate[]
): ResolvedOsFileWorkspace | null {
  let best: ResolvedOsFileWorkspace | null = null
  for (const workspace of candidates) {
    if (!workspace.path) {
      continue
    }
    const relativePath = relativePathInsideRoot(workspace.path, filePath)
    if (relativePath === null) {
      continue
    }
    // Why: nested workspaces both match; the deepest root is the one the user thinks the file lives in.
    if (!best || workspace.path.length > best.workspace.path.length) {
      best = { workspace, relativePath }
    }
  }
  return best
}
