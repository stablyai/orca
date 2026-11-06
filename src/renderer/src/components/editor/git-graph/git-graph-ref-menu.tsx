import { normalizeRuntimePathForComparison } from '../../../../../shared/cross-platform-path'
import { useRef, useState } from 'react'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger
} from '@/components/ui/context-menu'
import { useAppStore } from '@/store'
import { selectWorktreesByRepo } from '@/store/workspace-record-selectors'
import { gitGraphScope } from '@/lib/git-graph-tab'
import { getRuntimeGitRefs } from '@/runtime/runtime-git-status-client'
import { getConnectionId } from '@/lib/connection-context'
import { translate } from '@/i18n/i18n'
import type { GitHistoryItemRef } from '../../../../../shared/git/history/git-history-types'
import { getWorktreeExecutionHostId } from '../../../../../shared/execution-host'
import type { Worktree } from '../../../../../shared/worktree/types'
import { cn } from '@/lib/utils'

export function GitGraphRefMenu({
  itemRef,
  worktreeId,
  current
}: {
  itemRef: GitHistoryItemRef
  worktreeId: string
  current: boolean
}) {
  const [workspace, setWorkspace] = useState<Worktree>()
  const generation = useRef(0)
  const readWorkspace = async () => {
    const request = ++generation.current
    setWorkspace(undefined)
    const scope = gitGraphScope(worktreeId)
    if (!scope || !itemRef.id.startsWith('refs/heads/')) {
      return
    }
    try {
      const refs = await getRuntimeGitRefs(
        {
          target: scope.target,
          worktreeId,
          worktreePath: scope.worktree.path,
          connectionId: getConnectionId(worktreeId) ?? undefined
        },
        itemRef.id
      )
      const path = refs.find((ref) => ref.id === itemRef.id)?.worktreePath
      if (request !== generation.current) {
        return
      }
      const state = useAppStore.getState()
      const worktrees = Object.values(selectWorktreesByRepo(state)).flat()
      setWorkspace(
        worktrees.find(
          (row) =>
            path !== undefined &&
            normalizeRuntimePathForComparison(row.path) ===
              normalizeRuntimePathForComparison(path) &&
            row.id !== worktreeId &&
            getWorktreeExecutionHostId(
              row,
              state.repos.find((repo) => repo.id === row.repoId)
            ) === scope.route.executionHostId
        )
      )
    } catch {
      /* A failed refresh cannot offer navigation to a stale checkout. */
    }
  }
  return (
    <ContextMenu
      onOpenChange={(open) => {
        if (open) {
          void readWorkspace()
        } else {
          generation.current++
        }
      }}
    >
      <ContextMenuTrigger asChild>
        <span
          className={cn(
            'inline-block max-w-full truncate rounded-full border px-1.5 text-2xs text-muted-foreground',
            current && 'bg-accent font-medium text-foreground'
          )}
          title={itemRef.name}
        >
          {itemRef.name}
        </span>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem onSelect={() => void window.api.ui.writeClipboardText(itemRef.name)}>
          {translate('gitGraph.copyBranch', 'Copy branch name')}
        </ContextMenuItem>
        {workspace && (
          <ContextMenuItem
            onSelect={() => {
              const state = useAppStore.getState()
              state.setActiveWorktree(
                workspace.id,
                getWorktreeExecutionHostId(
                  workspace,
                  state.repos.find((repo) => repo.id === workspace.repoId)
                )
              )
            }}
          >
            {translate('gitGraph.switchWorkspace', 'Switch to workspace')}
          </ContextMenuItem>
        )}
      </ContextMenuContent>
    </ContextMenu>
  )
}
