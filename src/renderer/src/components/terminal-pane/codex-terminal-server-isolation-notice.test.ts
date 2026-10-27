// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CODEX_TERMINAL_SERVER_ISOLATION_SETTINGS_TARGET_ID } from '@/lib/settings-navigation-types'
import {
  mountHook,
  noticeTestStore,
  setNoticeState,
  unmountHooks
} from './codex-notice-test-harness'
import { useCodexTerminalServerIsolationNotice } from './codex-terminal-server-isolation-notice'

const { toastInfoMock } = vi.hoisted(() => ({ toastInfoMock: vi.fn() }))

vi.mock('sonner', () => ({ toast: { info: toastInfoMock } }))
vi.mock('@/store', () => import('./codex-notice-test-harness'))

const openSettingsPage = vi.fn()
const openSettingsTarget = vi.fn()
const codexTab = { 'wt-1': [{ id: 'tab-1', launchAgent: 'codex' }] }

function resetStore(overrides: Record<string, unknown> = {}): void {
  noticeTestStore.setState(
    {
      codexTerminalServerIsolationNoticeSeen: false,
      settings: { codexTerminalServerIsolation: true },
      tabsByWorktree: {},
      agentStatusByPaneKey: {},
      paneForegroundAgentByPaneKey: {},
      openSettingsPage,
      openSettingsTarget,
      markCodexTerminalServerIsolationNoticeSeen: () =>
        noticeTestStore.setState({ codexTerminalServerIsolationNoticeSeen: true }),
      ...overrides
    },
    true
  )
}

describe('useCodexTerminalServerIsolationNotice', () => {
  beforeEach(() => {
    toastInfoMock.mockReset()
    openSettingsPage.mockReset()
    openSettingsTarget.mockReset()
    resetStore()
  })

  afterEach(unmountHooks)

  it('shows once when the first Codex terminal starts, and marks it seen', async () => {
    await mountHook(useCodexTerminalServerIsolationNotice)
    expect(toastInfoMock).not.toHaveBeenCalled()

    await setNoticeState({ tabsByWorktree: codexTab })
    await setNoticeState({ agentStatusByPaneKey: { 'tab-2:leaf': { agentType: 'codex' } } })

    expect(toastInfoMock).toHaveBeenCalledTimes(1)
    expect(toastInfoMock.mock.calls[0]?.[1]).toMatchObject({ duration: Infinity })
    expect(noticeTestStore.getState().codexTerminalServerIsolationNoticeSeen).toBe(true)
  })

  it.each([
    ['it was already seen', { codexTerminalServerIsolationNoticeSeen: true }],
    ['the user turned the setting off', { settings: { codexTerminalServerIsolation: false } }],
    ['settings have not loaded', { settings: null }]
  ])('stays quiet when %s', async (_name, overrides) => {
    resetStore({ ...overrides, tabsByWorktree: codexTab })
    await mountHook(useCodexTerminalServerIsolationNotice)
    expect(toastInfoMock).not.toHaveBeenCalled()
  })

  it('shows once the persisted seen flag loads after mount', async () => {
    // Why seen: true: the store's default until persisted UI arrives.
    resetStore({ codexTerminalServerIsolationNoticeSeen: true, tabsByWorktree: codexTab })
    await mountHook(useCodexTerminalServerIsolationNotice)
    expect(toastInfoMock).not.toHaveBeenCalled()

    await setNoticeState({ codexTerminalServerIsolationNoticeSeen: false })
    expect(toastInfoMock).toHaveBeenCalledTimes(1)
  })

  it('stops waiting when the user turns the setting off', async () => {
    await mountHook(useCodexTerminalServerIsolationNotice)
    await setNoticeState({ settings: { codexTerminalServerIsolation: false } })
    await setNoticeState({ tabsByWorktree: codexTab })
    expect(toastInfoMock).not.toHaveBeenCalled()
  })

  it('opens Settings at the Codex server setting', async () => {
    resetStore({ tabsByWorktree: codexTab })
    await mountHook(useCodexTerminalServerIsolationNotice)

    toastInfoMock.mock.calls[0]?.[1]?.action.onClick()

    expect(openSettingsPage).toHaveBeenCalledTimes(1)
    expect(openSettingsTarget).toHaveBeenCalledWith({
      pane: 'agents',
      repoId: null,
      sectionId: CODEX_TERMINAL_SERVER_ISOLATION_SETTINGS_TARGET_ID
    })
  })
})
