import { useAppStore } from '@/store'
import { basename } from '@/lib/path'
import { detectLanguage } from '@/lib/language-detect'
import { findRepoForHost } from '@/store/slices/repo-host-identity'
import { toSshExecutionHostId } from '../../../../shared/execution-host'
import type { TreeNode } from '../right-sidebar/file-explorer-types'
import { useFloatingFileViewers } from './floating-file-viewer-state'

export function openMultiplexerFileViewer(
  node: Pick<TreeNode, 'path' | 'relativePath' | 'name' | 'operationOwner'>,
  worktreeId: string
): boolean {
  const state = useAppStore.getState()
  if (state.activeView !== 'multiplexer') {
    return false
  }
  const owner = node.operationOwner
  if (!owner || owner.kind === 'unresolved') {
    return false
  }
  const hostId =
    owner.kind === 'runtime'
      ? owner.executionHostId
      : owner.kind === 'ssh'
        ? toSshExecutionHostId(owner.connectionId)
        : 'local'
  const workspace = state.getKnownWorktreeById(worktreeId, hostId)
  if (!workspace) {
    return false
  }
  const repo = findRepoForHost(state.repos, workspace.repoId, { hostId })
  useFloatingFileViewers.getState().open({
    filePath: node.path,
    relativePath: node.relativePath,
    worktreeId,
    worktreePath: workspace.path,
    owner,
    projectName: repo?.displayName || basename(workspace.path),
    workspaceName: workspace.displayName || workspace.branch || basename(workspace.path),
    language: detectLanguage(node.name)
  })
  return true
}
