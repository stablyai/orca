import { useEffect, useRef, useState } from 'react'
import { isWebClientLocation } from '@/app-shell/platform/web-client-location'
import { useAppStore } from '@/store/index'
import { pairedServerMirrors } from '@/runtime/workspace-layout/frames/paired-server-workspace'
import {
  isTabPaneTreeHeld,
  onTabPaneTreeRedraw,
  requestTabPaneTreeRedraw
} from '@/runtime/workspace-layout/intents/layout-owner-pane-tree-holds'
import { isHostAuthoritativeLayout } from '../reconciliation/terminal-live-layout-reconciliation'
import { reconcileMountedPanesToLayout } from '../reconciliation/terminal-pane-frame-reconciliation'
import type { TerminalPaneMountedController } from '../../mounting/use-terminal-pane-lifecycle-stage'

/** Local tabs follow main’s framed tree; paired tabs use host reconciliation, and pending local commands hold their tab until answered. */
export function useLayoutOwnerPaneTree(controller: TerminalPaneMountedController): void {
  const {
    closePaneLocally,
    expandedPaneIdRef,
    isolatedPaneKey,
    managerRef,
    terminalManager,
    persistLayoutSnapshot,
    restoredLayout,
    tabId,
    worktreeId
  } = controller
  const [redraws, setRedraws] = useState(0)
  useEffect(
    () =>
      onTabPaneTreeRedraw((redrawnTabId) => {
        if (redrawnTabId === tabId) {
          setRedraws((count) => count + 1)
        }
      }),
    [tabId]
  )
  const zoomed = restoredLayout.expandedLeafId != null || isolatedPaneKey !== null
  const wasZoomed = useRef(zoomed)
  useEffect(() => {
    // Collapsing writes the window's pre-zoom tree to the store; main's comes back from frames.
    if (wasZoomed.current && !zoomed) {
      requestTabPaneTreeRedraw(tabId)
    }
    wasZoomed.current = zoomed
  }, [zoomed, tabId])
  useEffect(() => {
    const manager = managerRef.current
    if (
      !terminalManager ||
      manager !== terminalManager ||
      isTabPaneTreeHeld(tabId) ||
      // By host kind, as frames decide it: a paired-server tab may not have bound a remote PTY yet.
      pairedServerMirrors(useAppStore.getState())(worktreeId) ||
      isHostAuthoritativeLayout({
        isWebClient: isWebClientLocation(),
        ptyIdsByLeafId: restoredLayout.ptyIdsByLeafId
      })
    ) {
      return
    }
    const changed = reconcileMountedPanesToLayout({
      tabId,
      manager,
      layout: restoredLayout,
      closePane: (paneId, leafId, kind) => {
        if (kind === 'user') {
          closePaneLocally(paneId, leafId, 'user')
        } else {
          // An exited pane closes as the window's exit path closes it: no user-close clean-up.
          manager.closePane(paneId)
        }
      },
      isExpanded: expandedPaneIdRef.current !== null || zoomed
    })
    if (changed) {
      persistLayoutSnapshot()
    }
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- closePaneLocally/persistLayoutSnapshot change with tab callbacks; re-reconciling on that would replay layout writes.
  }, [
    restoredLayout,
    redraws,
    zoomed,
    tabId,
    worktreeId,
    terminalManager,
    managerRef,
    expandedPaneIdRef
  ])
}
