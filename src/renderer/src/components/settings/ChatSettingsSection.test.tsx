// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getDefaultSettings } from '../../../../shared/constants'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import { ChatSettingsSection } from './ChatSettingsSection'
import { ActiveSettingsSectionProvider } from './SettingsSection'
import { getChatAppearanceSearchEntries } from './chat-appearance-search'
import { buildSettingsNavigationMetadata } from '@/hooks/useSettingsNavigationMetadata'
import { buildCmdJSettingsResults } from '../cmd-j/palette-results'
import { isSettingsNavigationTarget } from '@/lib/settings-navigation-types'
import { getSettingsSectionId, getSettingsScrollTarget } from './settings-navigation-foundations'

const state = vi.hoisted((): { settingsSearchQuery: string; settings: GlobalSettings | null } => ({
  settingsSearchQuery: '',
  settings: null
}))
vi.mock('../../store', () => ({
  useAppStore: Object.assign((selector: (value: typeof state) => unknown) => selector(state), {
    getState: () => state
  })
}))

afterEach(cleanup)
beforeEach(() => {
  state.settingsSearchQuery = ''
  state.settings = null
})

function renderChat(enabled: boolean | undefined) {
  const settings = { ...getDefaultSettings('/tmp'), experimentalStructuredNativeChat: enabled }
  state.settings = settings
  const updateSettings = vi.fn(async (updates: Partial<GlobalSettings>) => {
    if (state.settings) {
      state.settings = { ...state.settings, ...updates }
    }
  })
  const element = (active = 'chat') => (
    <ActiveSettingsSectionProvider value={active}>
      <ChatSettingsSection
        settings={settings}
        updateSettings={updateSettings}
        searchEntries={getChatAppearanceSearchEntries()}
        isMounted
      />
    </ActiveSettingsSectionProvider>
  )
  return { ...render(element()), element, updateSettings }
}

describe('Chat settings page', () => {
  it.each([false, undefined])('is absent with structured chat set to %s', (enabled) => {
    const { container } = renderChat(enabled)
    expect(container.querySelector('#chat')).toBeNull()
  })

  it('renders the existing controls under Appearance and writes the same settings', async () => {
    const { container, updateSettings } = renderChat(true)
    expect(screen.getByRole('heading', { name: 'Chat', level: 2 })).toBeTruthy()
    expect(screen.getByRole('heading', { name: 'Appearance', level: 3 })).toBeTruthy()
    expect(container.querySelector('button[aria-controls="appearance-section-chat"]')).toBeNull()
    expect(screen.getByRole('spinbutton', { name: 'Text size' }).getAttribute('value')).toBe('14')
    expect(screen.getByRole('spinbutton', { name: 'Code text size' }).getAttribute('value')).toBe(
      '12'
    )
    expect(screen.getByRole('radio', { name: 'Comfortable' })).toBeTruthy()
    fireEvent.click(screen.getByRole('radio', { name: 'Wide' }))
    await waitFor(() =>
      expect(updateSettings).toHaveBeenLastCalledWith({ nativeChatAppearance: { width: 'wide' } })
    )
    fireEvent.click(screen.getByRole('button', { name: 'Reset' }))
    await waitFor(() =>
      expect(updateSettings).toHaveBeenLastCalledWith({ nativeChatAppearance: undefined })
    )
  })

  it('unmounts the page when the opt-in is disabled while it is selected', () => {
    const { container, rerender } = renderChat(true)
    rerender(
      <ActiveSettingsSectionProvider value="chat">
        <ChatSettingsSection
          settings={{ ...getDefaultSettings('/tmp'), experimentalStructuredNativeChat: false }}
          updateSettings={vi.fn()}
          searchEntries={[]}
          isMounted
        />
      </ActiveSettingsSectionProvider>
    )
    expect(container.querySelector('#chat')).toBeNull()
  })

  it.each(['Chat', 'Appearance'])('shows every row for the %s heading search', (query) => {
    state.settingsSearchQuery = query
    renderChat(true)
    expect(screen.getByRole('spinbutton', { name: 'Text size' })).toBeTruthy()
    expect(screen.getByRole('spinbutton', { name: 'Code text size' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Reset' })).toBeTruthy()
  })

  it('indexes Appearance on Chat without adding ambiguous palette rows', () => {
    const sections = buildSettingsNavigationMetadata({
      isMac: true,
      isWindows: false,
      isWebClient: false,
      experimentalStructuredNativeChat: true,
      repos: []
    })
    const results = buildCmdJSettingsResults(sections)
    expect(results.filter((entry) => entry.title === 'Appearance')).toHaveLength(1)
    const chatResults = results.filter((entry) => entry.sectionId === 'chat')
    expect(chatResults.map((entry) => entry.title)).not.toContain('Appearance')
    expect(chatResults.find((entry) => !entry.targetSectionId)?.configKeywords).toEqual(
      expect.arrayContaining(['appearance'])
    )
  })

  it('searches a moved row and resolves its deep link within the Chat page', () => {
    state.settingsSearchQuery = 'Code text size'
    const { container, element, rerender } = renderChat(true)
    expect(screen.queryByRole('spinbutton', { name: 'Text size' })).toBeNull()
    expect(screen.getByRole('spinbutton', { name: 'Code text size' })).toBeTruthy()
    const sections = buildSettingsNavigationMetadata({
      isMac: true,
      isWindows: false,
      isWebClient: false,
      experimentalStructuredNativeChat: true,
      repos: []
    })
    const result = buildCmdJSettingsResults(sections).find(
      (entry) => entry.sectionId === 'chat' && entry.title === 'Code text size'
    )
    expect(result?.targetSectionId).toBe('chat-code-text-size')
    const target = { pane: 'chat', repoId: null, sectionId: result?.targetSectionId } as const
    expect(isSettingsNavigationTarget(target)).toBe(true)
    expect(getSettingsSectionId(target.pane, target.repoId, new Map())).toBe('chat')
    expect(getSettingsScrollTarget(target.sectionId ?? '', container)?.querySelector('input')).toBe(
      screen.getByRole('spinbutton', { name: 'Code text size' })
    )
    rerender(element('appearance'))
    expect(container.querySelector('#chat')).toBeNull()
    state.settingsSearchQuery = ''
    rerender(element())
    for (const entry of getChatAppearanceSearchEntries().filter((entry) => entry.targetSectionId)) {
      expect(getSettingsScrollTarget(entry.targetSectionId ?? '', container)).toBeTruthy()
    }
  })
})
