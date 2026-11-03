// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest'
import { act, cleanup, renderHook } from '@testing-library/react'
import { useAppStore } from '@/store'
import { useTerminalPaneProcessExitActions } from './use-terminal-pane-process-exit-actions'
import { useTerminalPaneLayoutBindings } from './use-terminal-pane-layout-bindings'
import type { TerminalPaneLayoutController } from './use-terminal-pane-layout-persistence'
import type { TerminalPaneCloseController } from './use-terminal-pane-close-actions'

vi.mock('@/components/pet/pet-models', () => ({
  DEFAULT_PET_ID: 'claude-the-mage',
  OPENCODE_PET_ID: 'opencode-the-rogue',
  GREMLIN_PET_ID: 'gremlin-the-trickster',
  BUNDLED_PETS: [],
  BUNDLED_PET: { id: 'claude-the-mage' },
  isBundledPetId: () => true,
  findBundledPet: () => undefined
}))

vi.mock('@/i18n/i18n', () => ({
  translate: (key: string, fallback?: string) => fallback ?? key,
  i18n: { language: 'en', on: vi.fn(), off: vi.fn(), t: (key: string) => key },
  getIntlLocale: () => 'en',
  loadRendererUiLanguage: vi.fn(),
  setRendererPluginLanguagePacks: vi.fn()
}))

vi.mock('@/lib/agent-account-restart-startup', () => ({
  buildPaneAccountRestartStartup: vi.fn(() => ({
    command: "claude --resume 'session-a'",
    launchAgent: 'claude',
    startupCommandDelivery: 'shell-ready'
  }))
}))
vi.mock('./pty-connection', () => ({ connectPanePty: vi.fn(() => ({ dispose: vi.fn() })) }))

import { connectPanePty } from './pty-connection'

const LEAF = '11111111-1111-4111-8111-111111111111'
afterEach(cleanup)
it('restarts a working Claude queued before its unchanged PTY reattach finishes', () => {
  useAppStore.setState(useAppStore.getInitialState(), true)
  const layout = {
    root: { type: 'leaf' as const, leafId: LEAF },
    activeLeafId: LEAF,
    expandedLeafId: null,
    ptyIdsByLeafId: { [LEAF]: 'pty-old' }
  }
  const paneKey = `tab-1:${LEAF}`
  useAppStore.setState({
    terminalLayoutsByTabId: { 'tab-1': layout },
    agentStatusByPaneKey: {
      [paneKey]: {
        paneKey,
        tabId: 'tab-1',
        agentType: 'claude',
        state: 'working',
        prompt: '',
        updatedAt: 1,
        stateStartedAt: 1,
        stateHistory: [],
        providerSession: { key: 'session_id', id: 'session-a' }
      }
    }
  })
  let attachedPtyId: string | null = null
  const transport = { getPtyId: () => attachedPtyId, detach: vi.fn(), destroy: vi.fn() }
  const pane = { id: 1, leafId: LEAF, container: { dataset: { ptyId: 'pty-old' } } }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the hook reads only the fields stubbed here; the rest are filled with vi.fn() below
  const controller = {
    tabId: 'tab-1',
    worktreeId: 'wt-1',
    cwd: '/repo',
    savedLayout: layout,
    managerRef: { current: { getPanes: () => [pane], setActivePane: vi.fn() } },
    paneTransportsRef: { current: new Map([[1, transport]]) },
    panePtyBindingsRef: { current: new Map() },
    consumePendingPaneAccountRestart: useAppStore.getState().consumePendingPaneAccountRestart
  } as unknown as TerminalPaneCloseController
  for (const key of [
    'clearCodexRestartNotice',
    'clearExitedPanePtyLayoutBinding',
    'clearRuntimePaneTitle',
    'clearTabPtyId',
    'dispatchNotification',
    'executeClosePane',
    'markTerminalBell',
    'handlePaneProcessDied',
    'setCacheTimerStartedAt',
    'setPaneProcessExitsByPaneId',
    'setRuntimePaneTitle',
    'setTerminalError',
    'setTerminalErrorsByPaneId',
    'showRestoredSessionBanner',
    'suppressPtyExit',
    'syncPanePtyLayoutBinding',
    'updateTabPtyId',
    'updateTabTitle'
  ]) {
    Object.assign(controller, { [key]: vi.fn() })
  }
  renderHook(() => useTerminalPaneProcessExitActions(controller))
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the bind path reads only tabId, the refs and setTabLayout; the rest are inert stubs
  const layoutController = {
    tabId: 'tab-1',
    managerRef: controller.managerRef,
    paneTransportsRef: controller.paneTransportsRef,
    setTabLayout: useAppStore.getState().setTabLayout,
    containerRef: { current: null },
    expandedPaneIdRef: { current: null },
    expandedStyleSnapshotRef: { current: new Map() },
    pendingPaneSizeRefreshFrameIdsRef: { current: new Map() },
    persistLayoutSnapshot: vi.fn(),
    setExpandedPaneId: vi.fn(),
    setTabPaneExpanded: vi.fn()
  } as unknown as TerminalPaneLayoutController
  const bindings = renderHook(() => useTerminalPaneLayoutBindings(layoutController))
  act(() => useAppStore.getState().queuePaneAccountRestarts(['pty-old'], 'claude'))
  expect(connectPanePty).not.toHaveBeenCalled()
  // Same-ID reattach goes through the leaf bind the connection prefers and leaves the layout identical.
  act(() => {
    attachedPtyId = 'pty-old'
    bindings.result.current.syncPanePtyLayoutBindingForLeaf(LEAF, 'pty-old', 1)
  })
  expect(useAppStore.getState().terminalLayoutsByTabId['tab-1']).toBe(layout)
  expect(connectPanePty).toHaveBeenCalledTimes(1)
  expect(useAppStore.getState().pendingPaneAccountRestarts).toEqual({})
})
