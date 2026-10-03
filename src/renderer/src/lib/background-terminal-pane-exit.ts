import {
  registerEagerPtyBuffer,
  type EagerPtyHandle
} from '@/components/terminal-pane/pty-dispatcher'
import { singlePaneLayoutSnapshot } from '@/store/slices/terminal-helpers'
import { useAppStore } from '@/store'

/** The id a background pane got, plus which lifetime of it this spawn owns. */
export type SpawnedPane = { ptyId: string; incarnationId?: string }

function persistExitedPaneOutput(tabId: string, leafId: string, output: string): void {
  const store = useAppStore.getState()
  const layout = store.terminalLayoutsByTabId[tabId]
  if (!layout) {
    return
  }
  const { ptyIdsByLeafId: existingPtyIds, buffersByLeafId: existingBuffers, ...rest } = layout
  const nextPtyIds = { ...existingPtyIds }
  delete nextPtyIds[leafId]
  const trimmedOutput = output.trim() ? output : ''
  store.setTabLayout(tabId, {
    ...rest,
    ...(Object.keys(nextPtyIds).length > 0 ? { ptyIdsByLeafId: nextPtyIds } : {}),
    ...(trimmedOutput
      ? {
          buffersByLeafId: {
            ...existingBuffers,
            [leafId]: output
          }
        }
      : existingBuffers
        ? { buffersByLeafId: existingBuffers }
        : {})
  })
}

// Why the incarnation: a relay-recycled id can hold the previous owner's exit, and draining that
// into this handler tears the pane down seconds after it launched.
// `onSuccessfulExit` replaces the dead-pane bookkeeping when the pane should close instead.
export function registerBackgroundPaneBuffer(
  tabId: string,
  leafId: string,
  pane: SpawnedPane,
  onSuccessfulExit?: () => void
): void {
  let eagerBuffer: EagerPtyHandle | null = null
  const onExit = (exitPtyId: string, code: number): void => {
    if (code === 0 && onSuccessfulExit) {
      onSuccessfulExit()
      return
    }
    persistExitedPaneOutput(tabId, leafId, eagerBuffer?.flush() ?? '')
    useAppStore.getState().clearTabPtyId(tabId, exitPtyId)
  }
  eagerBuffer = registerEagerPtyBuffer(pane.ptyId, onExit, pane.incarnationId)
}

export function collapseSetupSplit(tabId: string, primaryLeafId: string, setupPtyId: string): void {
  const store = useAppStore.getState()
  const layout = store.terminalLayoutsByTabId[tabId]
  if (!layout) {
    return
  }
  const primaryPtyId = layout.ptyIdsByLeafId?.[primaryLeafId]
  const primaryBuffer = layout.buffersByLeafId?.[primaryLeafId]
  store.setTabLayout(tabId, {
    ...singlePaneLayoutSnapshot(primaryLeafId, primaryPtyId),
    ...(primaryBuffer ? { buffersByLeafId: { [primaryLeafId]: primaryBuffer } } : {})
  })
  store.clearTabPtyId(tabId, setupPtyId)
}
