import { bindPanePtyExit } from '../../pty-connection/lifecycle/pane-pty-exit'
import type { ConnectPanePtySession } from '../../pty-connection/connect-pane-pty-session'
import { act, createRef, useImperativeHandle } from 'react'
import type { Root } from 'react-dom/client'
import { useAppStore } from '@/store/index'
import { CodexSharedServerBanner } from './CodexSharedServerBanner'
import { useTerminalPaneLifecycleRefs } from '../../mounting/use-terminal-pane-lifecycle-refs'
import {
  useTerminalPaneLayoutBindings,
  type TerminalPaneBindingController
} from '../../layout/ownership/use-terminal-pane-layout-bindings'
import { cleanupTerminalPaneMount } from '../../mounting/terminal-pane-mount-cleanup'
import { createTerminalPaneClosedHandler } from '../../mounting/terminal-pane-closed-handler'
import type { PtyTransport } from '../../pty-transport/pty-transport-types'
import type { PaneManager } from '@/lib/pane-manager/pane-manager'

export async function renderNoticePaneLifecycle(
  root: Root,
  ptyId: string,
  tabId: string,
  leafId: string,
  transport: PtyTransport,
  worktreeId: string
) {
  const transports = new Map([[1, transport]])
  const managerFixture = {
    getPanes: () => [{ id: 1, leafId }],
    getLeafId: () => leafId,
    getActivePane: () => null,
    destroy: () => {}
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Only these manager operations are reached by close and mount cleanup.
  const manager = managerFixture as unknown as PaneManager
  const actions = createRef<{ park: () => void; close: () => void }>()
  function PaneLifecycle() {
    const refs = useTerminalPaneLifecycleRefs()
    const state = useAppStore.getState()
    const partial: Partial<TerminalPaneBindingController> = {
      tabId,
      worktreeId,
      managerRef: { current: manager },
      paneTransportsRef: { current: transports },
      panePtyBindingsRef: { current: new Map() },
      paneMode2031Ref: { current: new Map() },
      paneKittyKeyboardModesRef: { current: new Map() },
      paneLastThemeModeRef: { current: new Map() },
      paneCwdRef: { current: new Map() },
      replayingPanesRef: refs.replayingPanesRef,
      paneTitlesRef: { current: {} },
      containerRef: { current: null },
      expandedPaneIdRef: { current: null },
      expandedStyleSnapshotRef: { current: new Map() },
      pendingPaneSizeRefreshFrameIdsRef: { current: [] },
      setTabLayout: state.setTabLayout,
      clearTabPtyId: state.clearTabPtyId,
      clearRuntimePaneTitle: state.clearRuntimePaneTitle,
      updateTabTitle: state.updateTabTitle,
      setTabPaneExpanded: state.setTabPaneExpanded,
      setTabCanExpandPane: state.setTabCanExpandPane,
      setPaneTitles: () => {},
      setRenamingPaneId: () => {},
      setPaneCount: () => {},
      setExpandedPaneId: () => {},
      persistLayoutSnapshot: () => {}
    }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: All controller fields used by layout bindings, close and cleanup are supplied.
    const controller = partial as TerminalPaneBindingController
    Object.assign(controller, useTerminalPaneLayoutBindings(controller))
    const context = { deps: controller, refs, deferredSplitHandoffs: new Map() }
    const closed = createTerminalPaneClosedHandler(
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Closed handler reads only the supplied deps, refs and handoffs.
      context as unknown as Parameters<typeof createTerminalPaneClosedHandler>[0]
    )
    useImperativeHandle(actions, () => ({
      close: () => closed(1, { leafId, reason: 'close' }),
      park: () =>
        cleanupTerminalPaneMount({
          manager,
          // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Cleanup reads the supplied lifecycle subset; connection and keyboard callbacks are not reached.
          deps: controller as unknown as Parameters<typeof cleanupTerminalPaneMount>[0]['deps'],
          refs,
          deferredSplitHandoffs: new Map(),
          expandedStyleSnapshots: new Map(),
          unregisterRuntimeTab: () => {},
          cancelResize: () => {}
        })
    }))
    return <CodexSharedServerBanner ptyId={ptyId} tabId={tabId} leafId={leafId} />
  }
  await act(async () => root.render(<PaneLifecycle />))
  if (!actions.current) {
    throw new Error('Terminal lifecycle did not mount')
  }
  return { ...actions.current, transports }
}

export async function deliverNoticePaneStartupExit(
  transport: PtyTransport,
  transports: Map<number, PtyTransport>,
  ptyId: string,
  tabId: string,
  paneKey: string
) {
  const state = useAppStore.getState()
  const session = {
    pane: { id: 1 },
    transport: transport,
    runtimeEnvironmentId: null,
    manager: { getPanes: () => [{ id: 1 }], setPaneGpuRendering: () => {} },
    deps: {
      tabId: tabId,
      worktreeId: 'wt-1',
      paneTransportsRef: { current: transports },
      isPtyShutdownPending: state.isPtyShutdownPending,
      consumeSuppressedPtyExit: state.consumeSuppressedPtyExit,
      clearRuntimePaneTitle: state.clearRuntimePaneTitle,
      clearTabPtyId: state.clearTabPtyId,
      setCacheTimerStartedAt: state.setCacheTimerStartedAt
    },
    processExitStateByPtyId: new Map(),
    currentProcessExitState: {},
    cacheKey: paneKey,
    spawnedFreshPtyId: ptyId,
    lastTerminalInputAt: Number.NaN,
    agentCompletionCoordinator: { dispose: () => {} },
    dropSideEffectFactConsumer: () => {},
    releaseHiddenRendererPtyDelivery: () => {},
    clearPanePtyFitBinding: () => {},
    clearExitedPanePtyLayoutBinding: () => {},
    resetRendererOrderedSeqForPtyExit: () => {}
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: All session fields reached by a sole newborn, non-suppressed exit are supplied.
  const mounted = session as unknown as ConnectPanePtySession
  bindPanePtyExit(mounted)
  await act(async () => mounted.onExit(ptyId, 1))
}
