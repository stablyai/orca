import { useEffect, useRef } from 'react'
import { useAppStore } from '../../../store'
import { beginParkedCapturePass } from '../parking/capture/parked-terminal-buffer-capture'
import {
  shutdownBufferCaptures,
  type ShutdownBufferCaptureOptions
} from './shutdown-buffer-captures'
import {
  captureTerminalShutdownLayout,
  captureTerminalShutdownLayoutYielding
} from './terminal-shutdown-layout-capture'
import { resolveLeafScrollbackBuffers } from './leaf-scrollback-resolution'
import { shouldPreserveTerminalScrollbackBuffers } from '../../../../../shared/workspace-session/workspace-session-terminal-buffers'
import type { TerminalPaneCloseController } from '../layout/close/use-terminal-pane-close-actions'

export function useTerminalShutdownBufferCapture({
  clearedScrollbackLeafIdsRef,
  managerRef,
  paneTransportsRef,
  setTabLayout,
  setTabLocalOnlyScrollback,
  tabId,
  worktreeId
}: Pick<
  TerminalPaneCloseController,
  | 'clearedScrollbackLeafIdsRef'
  | 'managerRef'
  | 'paneTransportsRef'
  | 'setTabLayout'
  | 'setTabLocalOnlyScrollback'
  | 'tabId'
  | 'worktreeId'
>): void {
  const shutdownCaptureGenerationRef = useRef(0)

  useEffect(() => {
    const captureBuffers = (options?: ShutdownBufferCaptureOptions): void | Promise<void> => {
      const manager = managerRef.current
      const state = useAppStore.getState()
      const existing = state.terminalLayoutsByTabId[tabId]
      // Mounting stores the layout; only closing the tab or its workspace removes it.
      if (!manager || !existing) {
        return
      }
      const panes = manager.getPanes()
      if (panes.length === 0) {
        return
      }
      const includeLocalBuffers = options?.includeLocalBuffers ?? true
      const shouldCaptureScrollbackBuffers = includeLocalBuffers
        ? true
        : shouldPreserveTerminalScrollbackBuffers(worktreeId, state.repos)
      // Why generation + re-read: the yield can admit a concurrent layout write;
      // applying the pre-yield snapshot would revert it.
      const pass = beginParkedCapturePass(shutdownCaptureGenerationRef)
      const args = {
        manager,
        paneTransports: paneTransportsRef.current,
        existingLayout: existing,
        // Empty mid-replay captures must fall back to the last good shared or local buffer.
        priorBuffersByLeafId: resolveLeafScrollbackBuffers({
          shared: existing,
          localOnly: state.localOnlyScrollbackByTabId[tabId]
        }),
        captureBuffers: shouldCaptureScrollbackBuffers,
        clearedScrollbackLeafIds: clearedScrollbackLeafIdsRef.current
      }
      const applyLayout = (layout: ReturnType<typeof captureTerminalShutdownLayout>): void => {
        if (!pass.isCurrent()) {
          return
        }
        if (options?.localOnly && layout.buffersByLeafId) {
          // Cold parks are frequent: keep layout structure shared but buffer bytes in the local-only field excluded from remote export.
          const { buffersByLeafId, ...structureOnly } = layout
          setTabLayout(tabId, structureOnly)
          setTabLocalOnlyScrollback(tabId, buffersByLeafId)
        } else {
          setTabLayout(tabId, layout)
          // A shared capture supersedes whatever the last park left behind, so the local copy goes.
          setTabLocalOnlyScrollback(tabId, null)
        }
        for (const pane of panes) {
          clearedScrollbackLeafIdsRef.current.delete(pane.leafId)
        }
      }
      if (options?.yieldBetweenPanes) {
        return captureTerminalShutdownLayoutYielding({
          ...args,
          readExistingLayout: () => useAppStore.getState().terminalLayoutsByTabId[tabId]
        }).then(applyLayout)
      }
      applyLayout(captureTerminalShutdownLayout(args))
    }
    shutdownBufferCaptures.set(tabId, captureBuffers)
    return () => {
      shutdownCaptureGenerationRef.current += 1
      if (shutdownBufferCaptures.get(tabId) === captureBuffers) {
        shutdownBufferCaptures.delete(tabId)
      }
    }
  }, [
    tabId,
    worktreeId,
    setTabLayout,
    setTabLocalOnlyScrollback,
    clearedScrollbackLeafIdsRef,
    managerRef,
    paneTransportsRef
  ])
}
