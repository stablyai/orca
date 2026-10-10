// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getDefaultSettings } from '../../../../shared/constants'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import { ChatSettingsSection } from './ChatSettingsSection'
import { ActiveSettingsSectionProvider } from './SettingsSection'
import { getChatAppearanceSearchEntries } from './chat-appearance-search'
import { getChatNamingSearchEntry } from './chat-naming-search'
import { getChatInlineVisualsSearchEntry } from './chat-inline-visuals-search'
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

function renderChat(
  enabled: boolean | undefined,
  showDesktopOnlySettings = true,
  hasUnsavedChatPromptChanges = false
) {
  const settings = { ...getDefaultSettings('/tmp'), experimentalNativeChat: enabled }
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
        writeSourceControlAiSettings={async () => {}}
        searchEntries={[
          ...getChatAppearanceSearchEntries(),
          ...(showDesktopOnlySettings
            ? [getChatNamingSearchEntry(), getChatInlineVisualsSearchEntry()]
            : [])
        ]}
        showDesktopOnlySettings={showDesktopOnlySettings}
        isMounted
        hasUnsavedChatPromptChanges={hasUnsavedChatPromptChanges}
      />
    </ActiveSettingsSectionProvider>
  )
  return { ...render(element()), element, updateSettings }
}

describe('Chat settings page', () => {
  it('keeps Chat appearance on paired web without ineffective host naming controls or search results', () => {
    const { container } = renderChat(true, false)
    expect(screen.getByRole('spinbutton', { name: 'Text size' })).toBeTruthy()
    expect(container.querySelector('#chat-names')).toBeNull()
    expect(screen.queryByRole('switch', { name: 'Name chats automatically' })).toBeNull()
    expect(screen.queryByRole('switch', { name: 'Toggle inline visuals' })).toBeNull()
    const sections = buildSettingsNavigationMetadata({
      isMac: false,
      isWindows: false,
      isWebClient: true,
      nativeChatEnabled: true,
      repos: []
    })
    const results = buildCmdJSettingsResults(sections).filter((entry) => entry.sectionId === 'chat')
    expect(results.some((entry) => entry.targetSectionId === 'chat-text-size')).toBe(true)
    expect(results.some((entry) => entry.targetSectionId === 'chat-names')).toBe(false)
    expect(results.some((entry) => entry.targetSectionId === 'chat-inline-visuals')).toBe(false)
  })

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

  it('renders Appearance, Inline visuals and Chat names as peers with separate cards', () => {
    const { container } = renderChat(true)
    const appearance = container.querySelector('#chat-appearance')
    const names = container.querySelector('#chat-names')
    const visuals = container.querySelector('#chat-inline-visuals')
    expect(screen.getByRole('heading', { name: 'Chat names', level: 3 })).toBeTruthy()
    expect(appearance).toBeTruthy()
    expect(names).toBeTruthy()
    expect(appearance?.parentElement).toBe(names?.parentElement)
    expect(visuals?.parentElement).toBe(appearance?.parentElement)
    expect(visuals?.querySelector('[data-slot="card"]')).toBeTruthy()
    expect(visuals?.contains(appearance)).toBe(false)
    expect(visuals?.contains(names)).toBe(false)
    expect(appearance?.closest('[data-slot="card"]')).toBeNull()
    expect(names?.closest('[data-slot="card"]')).toBeNull()
    const appearanceCard = screen
      .getByRole('spinbutton', { name: 'Text size' })
      .closest('[data-slot="card"]')
    const namesCard = screen
      .getByRole('switch', { name: 'Name chats automatically' })
      .closest('[data-slot="card"]')
    expect(appearanceCard).toBeTruthy()
    expect(namesCard).toBeTruthy()
    expect(appearanceCard).not.toBe(namesCard)
    expect(appearance?.contains(appearanceCard)).toBe(true)
    expect(names?.contains(namesCard)).toBe(true)
    expect(container.querySelectorAll('#chat-names')).toHaveLength(1)
  })

  it('unmounts the page when the opt-in is disabled while it is selected', () => {
    const { container, rerender } = renderChat(true)
    rerender(
      <ActiveSettingsSectionProvider value="chat">
        <ChatSettingsSection
          settings={{ ...getDefaultSettings('/tmp'), experimentalNativeChat: false }}
          updateSettings={vi.fn()}
          writeSourceControlAiSettings={async () => {}}
          searchEntries={[]}
          showDesktopOnlySettings
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
      nativeChatEnabled: true,
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

  it.each(['chat names', 'name', 'Name chats automatically'])(
    'finds %s and resolves its deep link to the naming section',
    (query) => {
      state.settingsSearchQuery = query
      const { container } = renderChat(true)
      expect(screen.getByRole('switch', { name: 'Name chats automatically' })).toBeTruthy()
      expect(screen.getByText('Command template')).toBeTruthy()
      expect(screen.queryByRole('spinbutton', { name: 'Text size' })).toBeNull()
      expect(container.querySelector('#chat-appearance')).toBeNull()
      const sections = buildSettingsNavigationMetadata({
        isMac: false,
        isWindows: true,
        isWebClient: false,
        nativeChatEnabled: true,
        repos: []
      })
      const result = buildCmdJSettingsResults(sections).find(
        (entry) => entry.sectionId === 'chat' && entry.title === 'Chat names'
      )
      expect(result?.targetSectionId).toBe('chat-names')
      expect(result?.configKeywords).toContain('name chats automatically')
      const target = { pane: 'chat', repoId: null, sectionId: result?.targetSectionId } as const
      expect(isSettingsNavigationTarget(target)).toBe(true)
      expect(getSettingsScrollTarget(target.sectionId ?? '', container)).toBe(
        container.querySelector('#chat-names')
      )
    }
  )

  it('retains the unsaved naming draft when search no longer matches Chat', () => {
    const { element, rerender, container } = renderChat(true, true, true)
    const template = screen.getByText('Command template').nextElementSibling
    if (!(template instanceof HTMLTextAreaElement)) {
      throw new Error('Command template textarea is missing')
    }
    fireEvent.change(template, { target: { value: 'Unsaved: {firstPrompt}' } })
    state.settingsSearchQuery = 'unrelated setting'
    rerender(element())
    expect(screen.getByDisplayValue('Unsaved: {firstPrompt}')).toBe(template)
    expect(screen.getByRole('button', { name: 'Save' })).toBeTruthy()
    expect(container.querySelector('#chat-names')).toBeTruthy()
    expect(container.querySelector('#chat-appearance')).toBeNull()
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
      nativeChatEnabled: true,
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

  it.each([
    ['Match terminal interface', 'chat-match-terminal-interface', 'switch'],
    ['Contrast', 'chat-contrast', 'slider']
  ])('searches %s and resolves its Chat deep link', (title, targetSectionId, role) => {
    state.settingsSearchQuery = title
    const { container } = renderChat(true)
    expect(screen.getByRole(role, { name: title })).toBeTruthy()
    const sections = buildSettingsNavigationMetadata({
      isMac: true,
      isWindows: false,
      isWebClient: false,
      nativeChatEnabled: true,
      repos: []
    })
    const result = buildCmdJSettingsResults(sections).find(
      (entry) => entry.sectionId === 'chat' && entry.title === title
    )
    expect(result?.targetSectionId).toBe(targetSectionId)
    expect(getSettingsScrollTarget(targetSectionId, container)).toBeTruthy()
  })
})
