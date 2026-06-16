import type * as Monaco from 'monaco-editor'
import { useAppStore } from '@/store'
import { detectLanguage } from '@/lib/language-detect'
import { getConnectionId } from '@/lib/connection-context'
import { getRuntimeEnvironmentIdForWorktree } from '@/lib/worktree-runtime-owner'
import { registerTreeSitterDefinitions } from '@/lib/tree-sitter-definitions/definition-provider'
import { relativePathInsideRoot } from '../../../../shared/cross-platform-path'
import { getRightSidebarWorktreeRuntimeSettings } from '../right-sidebar/file-explorer-runtime-owner'

let registered = false

// Resolve which open worktree owns an absolute path (longest matching root), so
// Go to Definition keys off the file under edit rather than the globally active
// worktree — they differ in split views and multi-worktree sessions, and the
// wrong root would search a different repo (and the wrong SSH host).
function worktreeForFilePath(
  worktrees: readonly { id: string; path?: string | null }[],
  filePath: string
): { id: string; path: string } | null {
  let best: { id: string; path: string } | null = null
  for (const wt of worktrees) {
    if (wt.path && relativePathInsideRoot(wt.path, filePath) !== null) {
      if (!best || wt.path.length > best.path.length) {
        best = { id: wt.id, path: wt.path }
      }
    }
  }
  return best
}

// Wire Orca's store into the tree-sitter definition provider once. Kept out of
// MonacoEditor and the pure lib module so each layer stays focused.
export function ensureTreeSitterDefinitions(monaco: typeof Monaco): void {
  if (registered) {
    return
  }
  registered = true
  registerTreeSitterDefinitions(monaco, {
    getContext(filePath) {
      const state = useAppStore.getState()
      const owner = worktreeForFilePath(state.allWorktrees(), filePath)
      const worktreeId = owner?.id ?? state.activeWorktreeId
      if (!worktreeId) {
        return null
      }
      const worktreePath = owner?.path ?? state.getKnownWorktreeById(worktreeId)?.path
      if (!worktreePath) {
        return null
      }
      return {
        settings: getRightSidebarWorktreeRuntimeSettings(worktreeId),
        worktreeId,
        worktreePath,
        connectionId: getConnectionId(worktreeId) ?? undefined
      }
    },
    openTarget(filePath, line, column) {
      const state = useAppStore.getState()
      const owner = worktreeForFilePath(state.allWorktrees(), filePath)
      const worktreeId = owner?.id ?? state.activeWorktreeId
      if (!worktreeId) {
        // No owning or active worktree to anchor the tab to — don't open an
        // orphan editor with an empty worktreeId.
        return
      }
      const worktreePath = owner?.path ?? state.getKnownWorktreeById(worktreeId)?.path
      state.openFile({
        filePath,
        relativePath: worktreePath
          ? (relativePathInsideRoot(worktreePath, filePath) ?? filePath)
          : filePath,
        worktreeId,
        language: detectLanguage(filePath),
        // Open against the target worktree's own runtime owner so remote/SSH
        // definitions load regardless of which host is globally active.
        runtimeEnvironmentId: getRuntimeEnvironmentIdForWorktree(state, worktreeId),
        mode: 'edit'
      })
      // Two frames so the destination tab mounts before we reveal (matches the
      // file-search navigation pattern in search-match-open.ts).
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          useAppStore.getState().setPendingEditorReveal({ filePath, line, column, matchLength: 0 })
        })
      })
    }
  })
}
