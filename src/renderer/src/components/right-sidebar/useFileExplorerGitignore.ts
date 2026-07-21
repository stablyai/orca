import { useCallback, useRef, useState } from 'react'
import { toast } from 'sonner'
import type { GitPushTarget } from '../../../../shared/types'
import type {
  AppendGitignoreEntriesResult,
  GitignoreEntry
} from '../../../../shared/gitignore-entry'
import { appendRuntimeGitignoreEntries, type RuntimeGitContext } from '@/runtime/runtime-git-client'
import { extractIpcErrorMessage } from '@/lib/ipc-error'
import { useAppStore } from '@/store'
import { refreshGitStatusForWorktree } from './git-status-refresh'
import type { FileExplorerRowProjection } from './file-explorer-row-projection'
import type { TreeNode } from './file-explorer-types'
import { translate } from '@/i18n/i18n'

export function getFileExplorerGitignoreEntries(
  node: TreeNode,
  selectedPaths: Set<string>,
  rowProjection: FileExplorerRowProjection
): GitignoreEntry[] {
  const selectedNodes = selectedPaths.has(node.path)
    ? rowProjection.getRowsByPaths(selectedPaths)
    : [node]
  const normalizedNodes = selectedNodes
    .filter((entry) => entry.relativePath.length > 0)
    .map((entry) => ({
      node: entry,
      relativePath: entry.relativePath.replace(/\\/g, '/')
    }))
  const selectedDirectories = normalizedNodes
    .filter(({ node: entry }) => entry.isDirectory)
    .map(({ relativePath }) => relativePath)

  return normalizedNodes
    .filter(
      ({ relativePath }) =>
        !selectedDirectories.some(
          (directoryPath) =>
            directoryPath !== relativePath && relativePath.startsWith(`${directoryPath}/`)
        )
    )
    .map(({ node: entry, relativePath }) => ({
      relativePath,
      isDirectory: entry.isDirectory
    }))
}

function showGitignoreResult(result: AppendGitignoreEntriesResult): void {
  if (result.added.length === 1 && result.alreadyPresent.length === 0) {
    toast.success(
      translate(
        'auto.components.right.sidebar.useFileExplorerGitignore.726acd5472',
        "Added '{{value0}}' to .gitignore",
        { value0: result.added[0] }
      )
    )
    return
  }
  if (result.added.length > 1 && result.alreadyPresent.length === 0) {
    toast.success(
      translate(
        'auto.components.right.sidebar.useFileExplorerGitignore.f6e5ab1c32',
        'Added {{value0}} items to .gitignore',
        { value0: result.added.length }
      )
    )
    return
  }
  if (result.added.length === 0 && result.alreadyPresent.length === 1) {
    toast.info(
      translate(
        'auto.components.right.sidebar.useFileExplorerGitignore.dbd677f334',
        "'{{value0}}' is already in .gitignore",
        { value0: result.alreadyPresent[0] }
      )
    )
    return
  }
  if (result.added.length === 0 && result.alreadyPresent.length > 1) {
    toast.info(
      translate(
        'auto.components.right.sidebar.useFileExplorerGitignore.c17e6b4e06',
        '{{value0}} items are already in .gitignore',
        { value0: result.alreadyPresent.length }
      )
    )
    return
  }
  if (result.added.length > 0) {
    toast.success(
      translate(
        'auto.components.right.sidebar.useFileExplorerGitignore.8123eafa6b',
        'Updated .gitignore: {{value0}} added, {{value1}} already present',
        { value0: result.added.length, value1: result.alreadyPresent.length }
      )
    )
  }
}

export async function performFileExplorerGitignoreAction(args: {
  context: RuntimeGitContext
  entries: GitignoreEntry[]
  refreshTree: () => Promise<void>
  refreshGitStatus: () => Promise<void>
}): Promise<void> {
  try {
    const result = await appendRuntimeGitignoreEntries(args.context, args.entries)
    const refreshResults = await Promise.allSettled([
      Promise.resolve().then(args.refreshTree),
      Promise.resolve().then(args.refreshGitStatus)
    ])
    showGitignoreResult(result)
    if (refreshResults.some((refreshResult) => refreshResult.status === 'rejected')) {
      toast.warning(
        translate(
          'auto.components.right.sidebar.useFileExplorerGitignore.d07c6646df',
          'Updated .gitignore, but could not refresh the File Explorer'
        )
      )
    }
  } catch (error) {
    toast.error(
      extractIpcErrorMessage(
        error,
        translate(
          'auto.components.right.sidebar.useFileExplorerGitignore.updateFailed',
          'Could not update .gitignore'
        )
      )
    )
  }
}

async function refreshGitignoreStatus(
  context: RuntimeGitContext,
  pushTarget: GitPushTarget | undefined
): Promise<void> {
  if (!context.worktreeId) {
    return
  }
  const state = useAppStore.getState()
  await refreshGitStatusForWorktree({
    settings: context.settings,
    worktreeId: context.worktreeId,
    worktreePath: context.worktreePath,
    connectionId: context.connectionId,
    pushTarget,
    deps: {
      setGitStatus: state.setGitStatus,
      updateWorktreeGitIdentity: state.updateWorktreeGitIdentity,
      setUpstreamStatus: state.setUpstreamStatus,
      fetchUpstreamStatus: state.fetchUpstreamStatus
    }
  })
}

export function useFileExplorerGitignore(args: {
  enabled: boolean
  context: RuntimeGitContext | null
  pushTarget?: GitPushTarget
  selectedPaths: Set<string>
  rowProjection: FileExplorerRowProjection
  refreshTree: () => Promise<void>
}): {
  isAddingToGitignore: boolean
  addToGitignore: (node: TreeNode) => Promise<void>
} {
  const [isAddingToGitignore, setIsAddingToGitignore] = useState(false)
  const pendingRef = useRef(false)
  const addToGitignore = useCallback(
    async (node: TreeNode): Promise<void> => {
      if (!args.enabled || !args.context || pendingRef.current) {
        return
      }
      const context = args.context
      const entries = getFileExplorerGitignoreEntries(node, args.selectedPaths, args.rowProjection)
      if (entries.length === 0) {
        return
      }

      pendingRef.current = true
      setIsAddingToGitignore(true)
      try {
        await performFileExplorerGitignoreAction({
          context,
          entries,
          refreshTree: args.refreshTree,
          refreshGitStatus: () => refreshGitignoreStatus(context, args.pushTarget)
        })
      } finally {
        pendingRef.current = false
        setIsAddingToGitignore(false)
      }
    },
    [
      args.context,
      args.enabled,
      args.pushTarget,
      args.refreshTree,
      args.rowProjection,
      args.selectedPaths
    ]
  )

  return { isAddingToGitignore, addToGitignore }
}
