import { useEffect, useMemo, useState } from 'react'
import { useAppStore } from '@/store'
import type { WorkspaceViewPlacement } from '../../../shared/workspace-view-bridge'
import { projectPaneContext } from './cross-project-panes/project-pane-context'
import type { WorkspaceViewPaletteItem } from './worktree-jump-palette-model'
import type { PaletteFilterPredicate } from './cmd-j/palette-filter'
import { resolveHosts } from './cross-project-panes/workspace-view-session-readiness'
import { findWorkspaceViewSession } from './cross-project-panes/workspace-view-packet'
import { tabExecutionHost } from '@/store/slices/window-pane-selection'

export function useWorktreeJumpPalettePlacements(
  visible: boolean,
  query: string,
  predicate?: PaletteFilterPredicate | null
) {
  const layout = useAppStore((state) => state.windowPaneLayout)
  const [remote, setRemote] = useState<WorkspaceViewPlacement[]>([])
  const [hosts, setHosts] = useState<Record<string, string>>({})
  useEffect(() => {
    if (!visible || !window.orcaWorkspaceViews?.discover) {
      return
    }
    let disposed = false
    let revision = 0
    const refresh = () => {
      const current = ++revision
      void Promise.all([window.orcaWorkspaceViews!.discover(), resolveHosts()])
        .then(([entries, identities]) => {
          if (!disposed && current === revision) {
            setRemote(entries)
            setHosts(identities)
          }
        })
        .catch(() => {
          if (!disposed && current === revision) {
            setRemote([])
          }
        })
    }
    refresh()
    const timer = window.setInterval(refresh, 2000)
    return () => {
      disposed = true
      window.clearInterval(timer)
    }
  }, [visible, layout])
  const allPlacements = useMemo<WorkspaceViewPaletteItem[]>(() => {
    if (!visible) {
      return []
    }
    const entries = window.orcaWorkspaceViews?.discover
      ? remote
      : Object.values(layout?.panes ?? {}).flatMap((pane, index) =>
          pane.viewIds.map((id) => {
            const view = layout!.views[id]
            const context = projectPaneContext(useAppStore.getState(), view)
            return {
              windowId: 0,
              epoch: 0,
              windowTitle: 'This window',
              paneId: pane.id,
              paneNumber: index + 1,
              view: { ...view, label: context.session },
              projectName: context.projectName,
              workspace: context.workspace,
              hostName: context.hostName,
              availability: context.availability
            }
          })
        )
    return entries.map((placement) => {
      const state = useAppStore.getState()
      const tab =
        placement.owner && placement.session
          ? findWorkspaceViewSession(
              state,
              { view: placement.view, owner: placement.owner, session: placement.session },
              hosts
            )
          : undefined
      const localView = tab
        ? {
            ...placement.view,
            tabId: tab.id,
            entityId: tab.entityId,
            executionHostId: tabExecutionHost(state, tab)!
          }
        : placement.windowId === 0
          ? placement.view
          : undefined
      return {
        type: 'workspace-view' as const,
        id: `workspace-view:${placement.windowId}:${placement.epoch}:${placement.view.id}`,
        placement,
        localView
      }
    })
  }, [visible, layout, remote, hosts])
  const placements = useMemo(() => {
    const words = query.trim().toLocaleLowerCase().split(/\s+/)
    return allPlacements
      .filter(({ localView }) => {
        if (!predicate) {
          return true
        }
        if (!localView) {
          return false
        }
        const worktree = useAppStore
          .getState()
          .getKnownWorktreeById(localView.worktreeId, localView.executionHostId)
        return worktree
          ? predicate.matchesWorktree({ ...worktree, hostId: localView.executionHostId })
          : predicate.matchesGroupHostId(localView.executionHostId)
      })
      .filter(({ placement: entry }) => {
        const text = [
          entry.view.label,
          entry.projectName,
          entry.workspace,
          entry.hostName,
          entry.windowTitle
        ]
          .join(' ')
          .toLocaleLowerCase()
        return words.every((word) => text.includes(word))
      })
      .slice(0, 40)
  }, [allPlacements, predicate, query])
  return { placements, allPlacements }
}
