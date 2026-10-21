// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  mountHook,
  noticeTestStore,
  setNoticeState,
  unmountHooks
} from './codex-notice-test-harness'
import { useCodexSharedSettingsNotice } from './codex-shared-settings-notice'

const { toastInfoMock } = vi.hoisted(() => ({ toastInfoMock: vi.fn() }))

vi.mock('sonner', () => ({ toast: { info: toastInfoMock } }))
vi.mock('@/store', () => import('./codex-notice-test-harness'))

const codexTab = { 'wt-1': [{ id: 'tab-1', launchAgent: 'codex' }] }

function resetStore(overrides: Record<string, unknown> = {}): void {
  noticeTestStore.setState(
    {
      codexSharedSettingsNoticeSeen: false,
      tabsByWorktree: {},
      agentStatusByPaneKey: {},
      paneForegroundAgentByPaneKey: {},
      markCodexSharedSettingsNoticeSeen: () =>
        noticeTestStore.setState({ codexSharedSettingsNoticeSeen: true }),
      ...overrides
    },
    true
  )
}

const isSeen = (): unknown => noticeTestStore.getState().codexSharedSettingsNoticeSeen

describe('useCodexSharedSettingsNotice', () => {
  beforeEach(() => {
    toastInfoMock.mockReset()
    vi.stubGlobal('navigator', { userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' })
    resetStore()
  })

  afterEach(() => {
    unmountHooks()
    vi.unstubAllGlobals()
  })

  it('shows once on Windows when a Codex terminal appears, and marks it seen', async () => {
    await mountHook(useCodexSharedSettingsNotice)
    expect(toastInfoMock).not.toHaveBeenCalled()

    await setNoticeState({ tabsByWorktree: codexTab })
    await setNoticeState({ agentStatusByPaneKey: { 'tab-1:leaf': { agentType: 'codex' } } })

    expect(toastInfoMock).toHaveBeenCalledTimes(1)
    expect(toastInfoMock).toHaveBeenCalledWith('Codex in Orca now uses ~/.codex', {
      id: 'codex-shared-settings-notice',
      description:
        'Codex may ask again to trust folders or approve commands. Re-add any MCP servers you added only in Orca.',
      duration: Infinity
    })
    expect(isSeen()).toBe(true)
  })

  it('stays quiet off Windows', async () => {
    vi.stubGlobal('navigator', { userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)' })
    resetStore({ tabsByWorktree: codexTab })
    await mountHook(useCodexSharedSettingsNotice)
    expect(toastInfoMock).not.toHaveBeenCalled()
    expect(isSeen()).toBe(false)
  })

  it('stays quiet in a paired web client window', async () => {
    vi.stubGlobal('__ORCA_WEB_CLIENT__', true)
    resetStore({ tabsByWorktree: codexTab })
    await mountHook(useCodexSharedSettingsNotice)
    expect(toastInfoMock).not.toHaveBeenCalled()
  })

  it('shows once the persisted seen flag loads after mount', async () => {
    // Why seen: true: the store's default until persisted UI arrives.
    resetStore({ codexSharedSettingsNoticeSeen: true, tabsByWorktree: codexTab })
    await mountHook(useCodexSharedSettingsNotice)
    expect(toastInfoMock).not.toHaveBeenCalled()

    await setNoticeState({ codexSharedSettingsNoticeSeen: false })
    expect(toastInfoMock).toHaveBeenCalledTimes(1)
  })
})
