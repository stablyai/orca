// @vitest-environment happy-dom

import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  mountHook,
  noticeTestStore,
  setNoticeState,
  unmountHooks
} from './codex-notice-test-harness'
import { useCodexSharedSettingsNotice } from './codex-shared-settings-notice'

vi.mock('@/store', () => import('./codex-notice-test-harness'))

let notice: ReturnType<typeof useCodexSharedSettingsNotice> | null = null
function useNoticeProbe(): void {
  notice = useCodexSharedSettingsNotice()
}
const isVisible = (): boolean => notice?.visible === true

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
    notice = null
    vi.stubGlobal('navigator', { userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' })
    resetStore()
  })

  afterEach(() => {
    unmountHooks()
    vi.unstubAllGlobals()
  })

  it('shows once on Windows when a Codex terminal appears, and marks it seen', async () => {
    await mountHook(useNoticeProbe)
    expect(isVisible()).toBe(false)

    await setNoticeState({ tabsByWorktree: codexTab })
    await setNoticeState({ agentStatusByPaneKey: { 'tab-1:leaf': { agentType: 'codex' } } })

    expect(isVisible()).toBe(true)
    expect(isSeen()).toBe(true)
  })

  it('hides for good once dismissed', async () => {
    resetStore({ tabsByWorktree: codexTab })
    await mountHook(useNoticeProbe)
    expect(isVisible()).toBe(true)

    await act(async () => notice?.dismiss())
    expect(isVisible()).toBe(false)
    expect(isSeen()).toBe(true)
  })

  it('stays quiet off Windows', async () => {
    vi.stubGlobal('navigator', { userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)' })
    resetStore({ tabsByWorktree: codexTab })
    await mountHook(useNoticeProbe)
    expect(isVisible()).toBe(false)
    expect(isSeen()).toBe(false)
  })

  it('stays quiet in a paired web client window', async () => {
    vi.stubGlobal('__ORCA_WEB_CLIENT__', true)
    resetStore({ tabsByWorktree: codexTab })
    await mountHook(useNoticeProbe)
    expect(isVisible()).toBe(false)
  })

  it('shows once the persisted seen flag loads after mount', async () => {
    // Why seen: true: the store's default until persisted UI arrives.
    resetStore({ codexSharedSettingsNoticeSeen: true, tabsByWorktree: codexTab })
    await mountHook(useNoticeProbe)
    expect(isVisible()).toBe(false)

    await setNoticeState({ codexSharedSettingsNoticeSeen: false })
    expect(isVisible()).toBe(true)
  })
})
