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
    // Why: shorter relative path always means deeper root, immune to Unicode/encoding differences in root itself.
    if (!best || relativePath.length < best.relativePath.length) {
      best = { workspace, relativePath }
    }
  }
  return best
}
