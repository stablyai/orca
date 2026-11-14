import { useAppStore } from '@/store/index'
import { normalizeTerminalLayoutSnapshot } from '../layout/terminal-layout-normalization'
import {
  hydrateTerminalScrollbackRefs,
  restoreRetainedInlineScrollback
} from '../snapshots/terminal-scrollback-ref-hydration'
import type { LocalScrollbackSnapshots } from '@/runtime/hosted-terminals/hydration/host-terminal-scrollback-hydration'
import type { UseTerminalPaneLifecycleDeps } from './terminal-pane-lifecycle-types'

export function prepareTerminalPaneScrollback(
  deps: UseTerminalPaneLifecycleDeps,
  snapshots: LocalScrollbackSnapshots,
  retainedInlineLayout: UseTerminalPaneLifecycleDeps['initialLayoutRef']['current'] | undefined
): boolean {
  const normalizedInitialLayout = normalizeTerminalLayoutSnapshot(deps.initialLayoutRef.current)
  if (normalizedInitialLayout.changed) {
    deps.initialLayoutRef.current = normalizedInitialLayout.snapshot
    useAppStore.getState().setTabLayout(deps.tabId, normalizedInitialLayout.snapshot)
  }
  const initialLayoutHadBuffers = Boolean(deps.initialLayoutRef.current.buffersByLeafId)
  deps.initialLayoutRef.current = restoreRetainedInlineScrollback(
    deps.initialLayoutRef.current,
    retainedInlineLayout,
    useAppStore.getState().localOnlyScrollbackByTabId[deps.tabId],
    deps.clearedScrollbackLeafIdsRef?.current
  )
  const hydratedInitialScrollback = hydrateTerminalScrollbackRefs(
    deps.initialLayoutRef.current,
    snapshots
  )
  if (hydratedInitialScrollback.hydrated) {
    deps.initialLayoutRef.current = hydratedInitialScrollback.layout
  }
  return initialLayoutHadBuffers
}
