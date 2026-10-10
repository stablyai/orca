import { useCallback, useMemo } from 'react'
import { toast } from 'sonner'
import { useAppStore } from '@/store'
import { translate } from '@/i18n/i18n'
import { activateAndRevealWorktree } from '@/lib/worktree-activation'
import type { Worktree } from '../../../../../shared/worktree/types'
import type { PluginTaskSourceRef } from '../../../../../shared/plugins/plugin-task-source-ref'

const NO_WORKSPACES: readonly Worktree[] = []

/** Workspaces started from this source's items, keyed by item id. */
export function usePluginTaskWorkspaces(source: PluginTaskSourceRef): {
  workspacesFor: (itemId: string) => readonly Worktree[]
  openWorkspace: (worktreeId: string) => void
} {
  const worktreesByRepo = useAppStore((state) => state.worktreesByRepo)
  const byItem = useMemo(() => {
    const map = new Map<string, Worktree[]>()
    for (const worktrees of Object.values(worktreesByRepo)) {
      for (const worktree of worktrees) {
        const link = worktree.linkedPluginTask
        if (link?.pluginKey !== source.pluginKey || link.sourceId !== source.sourceId) {
          continue
        }
        const list = map.get(link.itemId)
        if (list) {
          list.push(worktree)
        } else {
          map.set(link.itemId, [worktree])
        }
      }
    }
    return map
  }, [source.pluginKey, source.sourceId, worktreesByRepo])
  const workspacesFor = useCallback(
    (itemId: string) => byItem.get(itemId) ?? NO_WORKSPACES,
    [byItem]
  )
  const openWorkspace = useCallback((worktreeId: string) => {
    if (activateAndRevealWorktree(worktreeId, { navigationIntent: 'user-open' }) === false) {
      toast.error(
        translate(
          'auto.components.TaskPage.pluginTaskWorkspaceOpenFailed',
          'Unable to open that workspace.'
        )
      )
    }
  }, [])
  return { workspacesFor, openWorkspace }
}
