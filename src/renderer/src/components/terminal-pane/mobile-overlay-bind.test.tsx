// @vitest-environment happy-dom
import { bindPtyConnectionTestMocks } from './pty-connection-mocks.spec'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useEffect, useRef } from 'react'
import { act, cleanup, render, within } from '@testing-library/react'
import { TooltipProvider } from '@/components/ui/tooltip'
import { hydrateDrivers } from '@/lib/pane-manager/mobile-driver-state'
import { hydrateOverrides } from '@/lib/pane-manager/mobile-fit-overrides'
import { useMobileOverlayTicks } from './use-mobile-overlay-ticks'
import { useTerminalPaneLifecycleStage } from './use-terminal-pane-lifecycle-stage'
import { useTerminalPaneLifecycleRefs } from './use-terminal-pane-lifecycle-refs'
import { createTerminalPanePtyDeps } from './terminal-pane-pty-deps'
import { TerminalPaneMobileDriverPortals } from './TerminalPaneRuntimePortals'
import { connectPanePty } from './pty-connection'
import { mockPanePtyArgs } from './pty-connection-test-connect-mock-pane'
import { buildPaneConnectionDeps } from './pty-connection-test-deps'
import { createManager, createMockTransport, createPane } from './pty-connection-test-pane-fixtures'
import { createInitialStoreState } from './pty-connection-test-store-fixtures'
import {
  installTerminalTestGlobals,
  restoreTerminalTestGlobals
} from './pty-connection-test-environment'
import type { UseTerminalPaneLifecycleDeps } from './terminal-pane-lifecycle-types'
import type { TerminalPaneController } from './use-terminal-pane-controller'
import type { StoreState } from './pty-connection-test-store-state'

const fixture = vi.hoisted(() => ({
  mount:
    (_deps: UseTerminalPaneLifecycleDeps): (() => void) =>
    () => {}
}))

// Replace Electron's manager mount while keeping the stage, dependency adapter and PTY binding real.
vi.mock('./use-terminal-pane-lifecycle', () => ({
  useTerminalPaneLifecycle(deps: UseTerminalPaneLifecycleDeps): void {
    const initialDeps = useRef(deps)
    useEffect(() => fixture.mount(initialDeps.current), [initialDeps])
  }
}))
vi.mock('./use-terminal-pane-store-actions', () => ({
  useTerminalPaneStoreActions: () => ({
    consumeSuppressedPtyExit: () => false,
    isPtyShutdownPending: () => false
  })
}))
vi.mock('@/runtime/runtime-rpc-client', async (importOriginal) =>
  (
    await import('@/runtime/layout-apply-test-transport.test-fixture')
  ).runtimeRpcClientWithLayoutApply(await importOriginal())
)

const PTY_ID = 'pty-overlay-bind'
const domWindow = window
let state: StoreState
let transportOptions: Record<string, unknown>[]

function OverlayHost({ controller }: { controller: TerminalPaneController }): React.JSX.Element {
  const { refreshMobileOverlays } = useMobileOverlayTicks(controller)
  const mountedController = { ...controller, refreshMobileOverlays }
  const refs = useTerminalPaneLifecycleRefs()
  fixture.mount = (deps) => {
    const ptyDeps = createTerminalPanePtyDeps({
      deps,
      refs,
      startupCwd: '/tmp/wt-1',
      mountFollowsTerminalPark: false,
      restoredPtyIdByLeafId: {},
      deferredSplitHandoffs: new Map()
    })
    const pane = controller.managedPanes[0]
    const manager = controller.managerRef.current
    if (!pane || !manager) {
      throw new Error('Missing test pane manager')
    }
    const binding = connectPanePty(pane, manager, ptyDeps)
    return () => binding.dispose()
  }
  useTerminalPaneLifecycleStage(mountedController)
  return (
    <TooltipProvider>
      <TerminalPaneMobileDriverPortals controller={mountedController} />
    </TooltipProvider>
  )
}

describe('mobile overlay after PTY binding', () => {
  beforeEach(async () => {
    state = {
      ...createInitialStoreState(() => state),
      tabsByWorktree: { 'wt-1': [{ id: 'tab-1', ptyId: null }] },
      ptyIdsByTabId: { 'tab-1': [] }
    }
    const transport = createMockTransport(null)
    transport.connect.mockImplementation(() => new Promise(() => {}))
    transportOptions = []
    bindPtyConnectionTestMocks({
      getState: () => state,
      getTransportQueue: () => [transport],
      getTransportOptions: () => transportOptions,
      getStoreSubscribers: () => [],
      setStoreSubscribers: () => {}
    })
    vi.stubGlobal('window', domWindow)
    await installTerminalTestGlobals()
    const api = window.api
    vi.stubGlobal('window', domWindow)
    domWindow.api = api
  })

  afterEach(async () => {
    cleanup()
    document.body.replaceChildren()
    hydrateOverrides([])
    hydrateDrivers([])
    await restoreTerminalTestGlobals()
    vi.stubGlobal('window', domWindow)
    vi.unstubAllGlobals()
  })

  it.each(['fit', 'driver'] as const)(
    'shows the banner after binding when %s hydration arrived without a bound PTY',
    async (kind) => {
      const mockDeps = buildPaneConnectionDeps(() => state)
      const mockPane = createPane(1)
      mockPane.container = document.createElement('div')
      document.body.append(mockPane.container)
      const [pane, manager, deps] = mockPanePtyArgs(mockPane, createManager(1), mockDeps)
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Only the lifecycle stage and mobile portal run; their live fields are supplied, and Electron mounting is replaced above.
      const controller = {
        ...deps,
        managedPanes: [pane],
        managerRef: { current: manager },
        paneCwdRef: { current: new Map() },
        settingsRef: { current: null },
        paneTitlesRef: { current: {} },
        getTabWideAgentHintLeafIdRef: { current: () => null },
        effectiveChatViewMode: false,
        chatLeafId: null,
        restorePaneTerminalFit: vi.fn(),
        restoreAllTerminalFits: vi.fn()
      } as unknown as TerminalPaneController
      render(<OverlayHost controller={controller} />)
      const query = within(pane.container)
      const actionName = kind === 'fit' ? 'Restore' : 'Take back'
      expect(query.queryByRole('button', { name: actionName })).toBeNull()

      act(() => {
        if (kind === 'fit') {
          hydrateOverrides([{ ptyId: PTY_ID, mode: 'mobile-fit', cols: 40, rows: 30 }])
        } else {
          hydrateDrivers([{ ptyId: PTY_ID, driver: { kind: 'mobile', clientId: 'phone-1' } }])
        }
      })
      expect(query.queryByRole('button', { name: actionName })).toBeNull()

      await act(async () => {
        const transport = deps.paneTransportsRef.current.get(pane.id)
        transport?.attach({ existingPtyId: PTY_ID, callbacks: {} })
        const onPtySpawn = transportOptions[0]?.onPtySpawn
        if (typeof onPtySpawn !== 'function') {
          throw new Error('Missing spawn callback')
        }
        onPtySpawn(PTY_ID)
      })

      expect(query.getByRole('button', { name: actionName })).toBeDefined()
      mockPane.container.remove()
    }
  )
})
