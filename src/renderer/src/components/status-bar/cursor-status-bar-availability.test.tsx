// @vitest-environment happy-dom

import { renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProviderRateLimits } from '../../../../shared/rate-limit-types'

const mocks = vi.hoisted(() => ({
  state: {
    rateLimits: {
      claude: null,
      codex: null,
      gemini: null,
      opencodeGo: null,
      kimi: null,
      antigravity: null,
      minimax: null,
      grok: null,
      cursor: null as ProviderRateLimits | null | undefined,
      minimaxCookieConfigured: false,
      grokAuthConfigured: false,
      cursorAuthConfigured: false
    },
    settings: {
      claudeManagedAccounts: [],
      codexManagedAccounts: [],
      opencodeSessionCookie: '',
      geminiCliOAuthEnabled: false,
      floatingTerminalEnabled: false,
      floatingTerminalTriggerLocation: 'floating-button',
      experimentalPet: false
    },
    refreshRateLimits: vi.fn(() => Promise.resolve()),
    openSettingsTarget: vi.fn(),
    openSettingsPage: vi.fn(),
    usagePercentageDisplay: 'used',
    statusBarUsageMode: 'verbose',
    setStatusBarUsageMode: vi.fn(),
    statusBarVisible: true,
    statusBarItems: ['cursor'],
    recordFeatureInteraction: vi.fn(),
    toggleStatusBarItem: vi.fn(),
    usageEmptyStateDismissed: false,
    detectedAgentIds: [] as string[],
    ensureDetectedAgents: vi.fn(() => Promise.resolve()),
    refreshDetectedAgents: vi.fn(() => Promise.resolve())
  }
}))

vi.mock('../../store', () => ({
  useAppStore: (selector: (state: typeof mocks.state) => unknown) => selector(mocks.state)
}))

vi.mock('../../store/selectors', () => ({
  selectFloatingWorkspaceHasUnread: () => false
}))

vi.mock('@/hooks/useShortcutLabel', () => ({
  useShortcutLabel: () => ''
}))

vi.mock('./ProviderDetailsMenu', () => ({
  CLOSE_ALL_CONTEXT_MENUS_EVENT: 'test-close-context-menus',
  useStatusBarMenuFocusHandoff: () => ({
    reset: vi.fn(),
    onPointerDownOutside: vi.fn(),
    onCloseAutoFocus: vi.fn()
  })
}))

import { useAvailableStatusBarToggles } from './use-available-status-bar-toggles'
import { useStatusBarController } from './use-status-bar-controller'

const cursorToggle = [{ id: 'cursor' as const }]

function renderAvailability() {
  return renderHook(() => ({
    controller: useStatusBarController(false),
    toggles: useAvailableStatusBarToggles(cursorToggle)
  }))
}

describe('Cursor status-bar availability', () => {
  beforeEach(() => {
    mocks.state.rateLimits.cursor = undefined
    mocks.state.rateLimits.cursorAuthConfigured = false
    mocks.state.detectedAgentIds = []
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  it('shows the segment and Appearance toggle for desktop credentials without the CLI', () => {
    mocks.state.rateLimits.cursorAuthConfigured = true

    const view = renderAvailability()

    expect(view.result.current.controller?.rosterProviders.map((item) => item.provider)).toEqual([
      'cursor'
    ])
    expect(view.result.current.toggles).toEqual(cursorToggle)
    view.unmount()
  })

  it('hides the segment and Appearance toggle without credentials or usage', () => {
    const view = renderAvailability()

    expect(view.result.current.controller?.rosterProviders).toEqual([])
    expect(view.result.current.toggles).toEqual([])
    view.unmount()
  })
})
