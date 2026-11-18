import { useEffect, useLayoutEffect } from 'react'
import {
  applyExpandedLayoutTo,
  cancelPendingPaneSizeRefreshFrames,
  restoreExpandedLayoutFrom
} from '../expand/expanded-pane-layout'
import { safeFit } from '@/lib/pane-manager/terminal-fit/pane-fit'
import { resolvePaneKeyForManager } from '@/lib/pane-manager/pane-key-resolution'
import type { TerminalPaneMountedController } from '../../mounting/use-terminal-pane-lifecycle-stage'

export function useTerminalPaneActivityIsolation({
  activityIsolationSnapshotRef,
  containerRef,
  isolatedPaneKey,
  managerRef,
  terminalManager,
  paneCount,
  pendingPaneSizeRefreshFrameIdsRef,
  tabId
}: Pick<
  TerminalPaneMountedController,
  | 'activityIsolationSnapshotRef'
  | 'containerRef'
  | 'isolatedPaneKey'
  | 'managerRef'
  | 'terminalManager'
  | 'paneCount'
  | 'pendingPaneSizeRefreshFrameIdsRef'
  | 'tabId'
>): void {
  useLayoutEffect(() => {
    if (!terminalManager || managerRef.current !== terminalManager) {
      return
    }
    const snapshots = activityIsolationSnapshotRef.current
    const scheduleRefit = (): number =>
      requestAnimationFrame(() => {
        const manager = managerRef.current
        if (!manager) {
          return
        }
        for (const pane of manager.getPanes()) {
          safeFit(pane)
        }
      })
    if (isolatedPaneKey === null) {
      restoreExpandedLayoutFrom(snapshots)
      const frame = scheduleRefit()
      return () => cancelAnimationFrame(frame)
    }
    const manager = managerRef.current
    const resolution = resolvePaneKeyForManager(tabId, isolatedPaneKey, manager)
    const resolvedPaneId = resolution.status === 'resolved' ? resolution.numericPaneId : null
    const applied =
      resolvedPaneId !== null &&
      ((manager?.getPanes().length ?? 0) <= 1 ||
        applyExpandedLayoutTo(resolvedPaneId, {
          managerRef,
          containerRef,
          expandedStyleSnapshotRef: activityIsolationSnapshotRef
        }))
    if (!applied) {
      restoreExpandedLayoutFrom(snapshots)
      const root = containerRef.current?.firstElementChild
      if (root instanceof HTMLElement) {
        snapshots.set(root, { display: root.style.display, flex: root.style.flex })
        root.style.display = 'none'
      }
      const frame = scheduleRefit()
      return () => cancelAnimationFrame(frame)
    }
    const frame = scheduleRefit()
    return () => cancelAnimationFrame(frame)
  }, [
    isolatedPaneKey,
    paneCount,
    tabId,
    activityIsolationSnapshotRef,
    containerRef,
    managerRef,
    terminalManager
  ])

  useEffect(() => {
    const snapshots = activityIsolationSnapshotRef.current
    return () => {
      restoreExpandedLayoutFrom(snapshots)
      cancelPendingPaneSizeRefreshFrames({ pendingPaneSizeRefreshFrameIdsRef })
    }
  }, [activityIsolationSnapshotRef, pendingPaneSizeRefreshFrameIdsRef])
}
