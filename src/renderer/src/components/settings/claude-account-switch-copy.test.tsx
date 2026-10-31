// @vitest-environment happy-dom

import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { getDefaultSettings } from '../../../../shared/constants'
import type { ClaudeRateLimitAccountsState } from '../../../../shared/managed-account-types'
import { i18n, translate } from '@/i18n/i18n'
import en from '@/i18n/locales/en.json'
import fr from '@/i18n/locales/fr.json'
import es from '@/i18n/locales/es.json'
import ja from '@/i18n/locales/ja.json'
import ko from '@/i18n/locales/ko.json'
import zh from '@/i18n/locales/zh.json'
import { ClaudeRunningSessionSwitchSetting } from './claude-running-session-switch-setting'
import { getAccountsClaudeSearchEntries } from './accounts-claude-search'
import { matchesSettingsSearch } from './settings-search'
import { createClaudeAccountActionRunner } from './accounts-pane-account-actions'
import {
  getClaudeAccountSwitchPrompt,
  resetClaudeAccountSwitchSessionsForTests
} from '@/lib/claude-account-switch-sessions'
import type * as AccountMove from '@/lib/claude-session-account-move'

const state = vi.hoisted(() => ({
  settings: { claudeAccountSwitchRunningSessions: 'keep' },
  settingsSearchQuery: '',
  consumePendingPaneAccountRestart: vi.fn(),
  queuePaneAccountRestarts: vi.fn(),
  updateSettings: vi.fn(),
  terminalLayoutsByTabId: {}
}))
const info = vi.hoisted(() => vi.fn())
vi.mock('sonner', () => ({ toast: { info, error: vi.fn(), success: vi.fn() } }))
vi.mock('@/store', () => ({
  useAppStore: Object.assign((selector: (value: typeof state) => unknown) => selector(state), {
    getState: () => state
  })
}))
vi.mock('@/lib/claude-session-account-move', async (original) => ({
  ...(await original<typeof AccountMove>()),
  findMovableClaudeSessions: vi.fn(),
  findQueuedClaudeRestartsOnAccount: () => []
}))

const catalogs = {
  en: { catalog: en, terminalWord: /terminal/i },
  fr: { catalog: fr, terminalWord: /termin(?:al|aux)/i },
  es: { catalog: es, terminalWord: /terminal/i },
  ja: { catalog: ja, terminalWord: /ターミナル/ },
  ko: { catalog: ko, terminalWord: /터미널/ },
  zh: { catalog: zh, terminalWord: /终端/ }
}
const accounts: ClaudeRateLimitAccountsState = {
  accounts: ['A', 'B'].map((id) => ({
    id,
    email: `Account ${id}`,
    authMethod: 'subscription-oauth',
    createdAt: 1,
    updatedAt: 1,
    lastAuthenticatedAt: 1
  })),
  activeAccountId: 'A'
}

afterEach(async () => {
  cleanup()
  state.settingsSearchQuery = ''
  resetClaudeAccountSwitchSessionsForTests()
  vi.clearAllMocks()
  await i18n.changeLanguage('en')
})

it.each(Object.entries(catalogs))(
  '%s mounts the terminal setting and search copy and interpolates Keep A → B',
  async (locale, { catalog, terminalWord }) => {
    i18n.addResourceBundle(locale, 'translation', catalog, true, true)
    await i18n.changeLanguage(locale)
    const title = translate(
      'accounts.claude.switchSessions.settingTitle',
      'When you switch accounts while Claude is running in terminals'
    )
    const description = translate(
      'accounts.claude.switchSessions.settingDescription',
      'Restarting continues each terminal conversation on the new account.'
    )
    expect(title).toMatch(terminalWord)
    expect(description).toMatch(terminalWord)
    expect(i18n.getResource(locale, 'translation', 'accounts.claude.nextLaunch')).toBeTruthy()
    const entry = getAccountsClaudeSearchEntries().find((candidate) => candidate.title === title)
    expect(entry).toMatchObject({ description })
    expect(matchesSettingsSearch(title, getAccountsClaudeSearchEntries())).toBe(true)
    state.settingsSearchQuery = title
    const updateSettings = vi.fn()
    const settings = getDefaultSettings('/test/home')
    const view = render(
      <ClaudeRunningSessionSwitchSetting settings={settings} updateSettings={updateSettings} />
    )
    expect(screen.getByText(title)).toBeDefined()
    expect(screen.getByText(description)).toBeDefined()
    expect(screen.getByRole('combobox', { name: title }).textContent).toContain(
      translate('accounts.claude.switchSessions.settingAsk', 'Ask')
    )
    view.rerender(
      <ClaudeRunningSessionSwitchSetting
        settings={{ ...settings, claudeAccountSwitchRunningSessions: 'keep' }}
        updateSettings={updateSettings}
      />
    )
    expect(screen.getByRole('combobox', { name: title }).textContent).toContain(
      translate('accounts.claude.switchSessions.settingKeep', 'Never restart')
    )
    expect(updateSettings).not.toHaveBeenCalled()
    const runner = createClaudeAccountActionRunner({
      accountOwner: { kind: 'local' },
      accountRuntime: { runtime: 'host', label: 'This computer' },
      isRemoteAccountScope: false,
      claudeAccounts: accounts,
      setClaudeAccounts: vi.fn(),
      setClaudeAction: vi.fn(),
      fetchSettings: vi.fn(async () => {}),
      recordFeatureInteraction: vi.fn(),
      isCurrentAccountOwner: () => true
    })
    await runner('select:B', async () => ({ ...accounts, activeAccountId: 'B' }))
    await waitFor(() => expect(info).toHaveBeenCalledTimes(1))
    const message = info.mock.calls[0]?.[1]?.description
    expect(message).toBe(
      translate('accounts.claude.nextLaunch', '', { value0: 'Account A', value1: 'Account B' })
    )
    expect(message).toMatch(terminalWord)
    expect(message).toContain('Account A')
    expect(message).toContain('Account B')
    expect(message).not.toMatch(/\{\{|\}\}/)
    expect(message).not.toMatch(/running Claude (?:chats|sessions) keep/i)
    expect(getClaudeAccountSwitchPrompt()).toBeNull()
    expect(state.queuePaneAccountRestarts).not.toHaveBeenCalled()
    expect(state.updateSettings).not.toHaveBeenCalled()
  }
)
