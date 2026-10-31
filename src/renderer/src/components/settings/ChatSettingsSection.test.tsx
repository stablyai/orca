// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getDefaultSettings } from '../../../../shared/constants'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import { ChatSettingsSection } from './ChatSettingsSection'
import { TooltipProvider } from '../ui/tooltip'
import { ActiveSettingsSectionProvider } from './SettingsSection'
import { getChatAppearanceSearchEntries } from './chat-appearance-search'
import { getChatNamingSearchEntry } from './chat-naming-search'
import { getChatInlineVisualsSearchEntry } from './chat-inline-visuals-search'
import { getChatBehaviorSearchEntries } from './chat-behavior-search'
import { AGENT_SESSION_QUEUED_MESSAGES_RUNTIME_CAPABILITY } from '../../../../shared/protocol-version'
import { setLocalRuntimeCapabilitiesForTests } from '@/runtime/local-runtime-capabilities'
import { i18n } from '@/i18n/i18n'
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

afterEach(async () => {
  cleanup()
  setLocalRuntimeCapabilitiesForTests(null)
  await i18n.changeLanguage('en')
})
beforeEach(() => {
  state.settingsSearchQuery = ''
  state.settings = null
  setLocalRuntimeCapabilitiesForTests([AGENT_SESSION_QUEUED_MESSAGES_RUNTIME_CAPABILITY])
})

function renderChat(
  showDesktopOnlySettings = true,
  hasUnsavedChatPromptChanges = false,
  overrides: Partial<GlobalSettings> = {}
) {
  const settings = { ...getDefaultSettings('/tmp'), ...overrides }
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
          ...getChatBehaviorSearchEntries(),
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
  return { ...render(element(), { wrapper: TooltipProvider }), element, updateSettings }
}

describe('Chat settings page', () => {
  it('moves the chat-or-CLI choice from the Chat page to the Agents list and its search', () => {
    renderChat(true)
    expect(screen.queryByText('Providers')).toBeNull()
    expect(screen.queryByRole('switch', { name: /as a chat/ })).toBeNull()
    const results = (isWebClient: boolean) =>
      buildCmdJSettingsResults(
        buildSettingsNavigationMetadata({
          isMac: true,
          isWindows: false,
          isWebClient,
          repos: []
        })
      ).filter((entry) => entry.targetSectionId === 'agents-installed')
    const [choice] = results(false)
    expect(choice?.sectionId).toBe('agents')
    for (const term of ['chat', 'cli', 'terminal', 'provider']) {
      expect(choice?.configKeywords.some((keyword) => keyword.includes(term))).toBe(true)
    }
    expect(results(true)).toEqual([])
  })

  it('retains the unsaved naming draft when search no longer matches Chat', () => {
    const { element, rerender, container } = renderChat(true, true)
    const naming = container.querySelector('#chat-names')
    if (!naming) {
      throw new Error('Chat naming section is missing')
    }
    const advanced = naming.querySelector('button[aria-expanded]')
    if (!advanced) {
      throw new Error('Advanced control is missing')
    }
    fireEvent.click(advanced)
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
    const { container, element, rerender } = renderChat()
    expect(screen.queryByRole('spinbutton', { name: 'Text size' })).toBeNull()
    expect(screen.getByRole('spinbutton', { name: 'Code text size' })).toBeTruthy()
    const sections = buildSettingsNavigationMetadata({
      isMac: true,
      isWindows: false,
      isWebClient: false,
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
