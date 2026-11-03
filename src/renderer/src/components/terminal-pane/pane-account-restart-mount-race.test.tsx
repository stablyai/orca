// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest'
import { act, cleanup, renderHook } from '@testing-library/react'
import { useAppStore } from '@/store'
import { useTerminalPaneProcessExitActions } from './use-terminal-pane-process-exit-actions'
import { notifyQueuedRestartPaneBound } from './pane-account-restart-readiness'
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
  act(() => useAppStore.getState().queuePaneAccountRestarts(['pty-old'], 'claude'))
  expect(connectPanePty).not.toHaveBeenCalled()
  // Same-ID reattach leaves the layout identical; only the bind signal reports the transport is ready.
  act(() => {
    attachedPtyId = 'pty-old'
    useAppStore
      .getState()
      .setTabLayout('tab-1', { ...layout, ptyIdsByLeafId: { [LEAF]: 'pty-old' } })
    notifyQueuedRestartPaneBound('tab-1', 'pty-old')
  })
  expect(useAppStore.getState().terminalLayoutsByTabId['tab-1']).toBe(layout)
  expect(connectPanePty).toHaveBeenCalledTimes(1)
  expect(useAppStore.getState().pendingPaneAccountRestarts).toEqual({})
})
