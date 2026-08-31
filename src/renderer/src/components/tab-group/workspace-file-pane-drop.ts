import { detectLanguage } from '@/lib/language-detect'
import { isPathInsideWorktree, toWorktreeRelativePath } from '@/lib/terminal-links'
import type { TabSplitDirection } from '../../store/slices/tabs'

export type WorkspaceFileOpenTarget = {
  filePath: string
  language: string
  relativePath: string
}

export type WorkspaceFilePaneDropDeps = {
  createEmptySplitGroup: (
    worktreeId: string,
    sourceGroupId: string,
    direction: TabSplitDirection
  ) => string | null
  isDirectory: (filePath: string) => Promise<boolean>
  openFile: (
    target: WorkspaceFileOpenTarget & {
      mode: 'edit'
      runtimeEnvironmentId?: string | undefined
      worktreeId: string
    },
    options: {
      focusEditor: boolean
      preview: boolean
      suppressActiveRuntimeFallback: boolean
      targetGroupId: string
    }
  ) => void
  setActiveTabType: (type: 'editor') => void
}

export function resolveWorkspaceFileOpenTarget(
  filePath: string,
  worktreePath: string | null | undefined
): WorkspaceFileOpenTarget {
  const relativePath =
    worktreePath && isPathInsideWorktree(filePath, worktreePath)
      ? (toWorktreeRelativePath(filePath, worktreePath) ?? filePath)
      : filePath
  return {
    filePath,
    language: detectLanguage(filePath),
    relativePath: relativePath.length > 0 ? relativePath : filePath
  }
}

/**
 * Opens Explorer-dragged paths in a new split beside `sourceGroupId`. Resolves to
 * the new group id, or null when the drop carried nothing openable.
 */
export async function openWorkspaceFilePathsInSplit(
  deps: WorkspaceFilePaneDropDeps,
  args: {
    paths: readonly string[]
    runtimeEnvironmentId: string | null
    sourceGroupId: string
    splitDirection: TabSplitDirection
    worktreeId: string
    worktreePath: string | null | undefined
  }
): Promise<string | null> {
  // Why: a folder drop must not leave an empty split behind, so filter before
  // splitting. Concurrent because isDirectory is a runtime round-trip on SSH
  // workspaces, and map keeps drop order regardless of settle order.
  const directoryFlags = await Promise.all(args.paths.map((path) => deps.isDirectory(path)))
  const openable = args.paths.filter((_, index) => !directoryFlags[index])
  if (openable.length === 0) {
    return null
  }

  const targetGroupId = deps.createEmptySplitGroup(
    args.worktreeId,
    args.sourceGroupId,
    args.splitDirection
  )
  if (!targetGroupId) {
    return null
  }

  deps.setActiveTabType('editor')
  openable.forEach((filePath, index) => {
    deps.openFile(
      {
        ...resolveWorkspaceFileOpenTarget(filePath, args.worktreePath),
        mode: 'edit',
        runtimeEnvironmentId: args.runtimeEnvironmentId ?? undefined,
        worktreeId: args.worktreeId
      },
      {
        // Why: only the tab left on top earns focus; focusing each open in turn
        // would thrash the editor for a multi-file drop.
        focusEditor: index === openable.length - 1,
        // Why: a deliberate drop is a permanent open — preview tabs would let the
        // next Explorer click replace the pane the user just created.
        preview: false,
        suppressActiveRuntimeFallback: args.runtimeEnvironmentId === null,
        targetGroupId
      }
    )
  })
  return targetGroupId
}
