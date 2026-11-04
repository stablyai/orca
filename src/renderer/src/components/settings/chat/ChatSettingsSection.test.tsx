// @vitest-environment happy-dom
// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getDefaultSettings } from '../../../../../shared/constants'
import type { GlobalSettings } from '../../../../../shared/global-settings-types'
import { ChatSettingsSection } from './ChatSettingsSection'
import { TooltipProvider } from '../../ui/tooltip'
import { ActiveSettingsSectionProvider } from '../section-layout/SettingsSection'
import { getChatAppearanceSearchEntries } from '../appearance/chat/chat-appearance-search'
import { getChatNamingSearchEntry } from './chat-naming-search'
import { getChatInlineVisualsSearchEntry } from './chat-inline-visuals-search'
import { getChatBehaviorSearchEntries } from './chat-behavior-search'
import { AGENT_SESSION_QUEUED_MESSAGES_RUNTIME_CAPABILITY } from '../../../../../shared/agent-session/agent-session-runtime-capabilities'
import { setLocalRuntimeCapabilitiesForTests } from '@/runtime/local-runtime-capabilities'
import { i18n } from '@/i18n/i18n'
import { buildSettingsNavigationMetadata } from '@/hooks/useSettingsNavigationMetadata'
import { buildCmdJSettingsResults } from '../../cmd-j/palette-results'
import { isSettingsNavigationTarget } from '@/lib/settings-navigation-types'
import {
  getSettingsSectionId,
  getSettingsScrollTarget
} from '../navigation/settings-navigation-foundations'
import ja from '@/i18n/locales/ja.json'
import { getSettingsSectionSearchEntries, matchesSettingsSearch } from '../search/settings-search'
import { useAppStore } from '@/store/index'
import { getChatLaunchSearchEntries } from './chat-launch-search'

vi.mock('@/lib/host-chat-program-acquisition', () => ({ useChatProgramFacts: () => {} }))

afterEach(async () => {
  cleanup()
  setLocalRuntimeCapabilitiesForTests(null)
  await i18n.changeLanguage('en')
})
beforeEach(() => {
  useAppStore.setState(useAppStore.getInitialState(), true)
  useAppStore.setState({ ensureNativeDetectedAgents: vi.fn(async () => []) })
  setLocalRuntimeCapabilitiesForTests([AGENT_SESSION_QUEUED_MESSAGES_RUNTIME_CAPABILITY])
})

function renderChat(
  showDesktopOnlySettings = true,
  hasUnsavedChatPromptChanges = false,
  overrides: Partial<GlobalSettings> = {}
) {
  const settings = { ...getDefaultSettings('/tmp'), ...overrides }
  useAppStore.setState({ settings })
  const updateSettings = vi.fn(async (updates: Partial<GlobalSettings>) => {
    const current = useAppStore.getState().settings
    if (current) {
      useAppStore.setState({ settings: { ...current, ...updates } })
    }
  })
  const element = (active = 'chat') => (
    <ActiveSettingsSectionProvider value={active}>
      <ChatSettingsSection
        settings={settings}
        updateSettings={updateSettings}
        writeSourceControlAiSettings={async () => {}}
        searchEntries={[
          ...(showDesktopOnlySettings ? getChatLaunchSearchEntries() : []),
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
  it('loads the native agent inventory when Chat settings is opened directly', () => {
    renderChat()
    expect(useAppStore.getState().ensureNativeDetectedAgents).toHaveBeenCalledOnce()
  })

  it('saves a per-agent choice through the same settings map without changing the default', async () => {
    const { updateSettings } = renderChat(true, false, { agentDefaultSurface: 'terminal' })
    fireEvent.click(
      within(screen.getByRole('radiogroup', { name: 'Open Claude as' })).getByRole('radio', {
        name: 'Chat'
      })
    )
    await waitFor(() =>
      expect(updateSettings).toHaveBeenCalledExactlyOnceWith({
        nativeChatProviders: { claude: true }
      })
    )
    expect(useAppStore.getState().settings?.agentDefaultSurface).toBe('terminal')
  })

  it('keeps desktop launch controls out of the web client settings', () => {
    const { container } = renderChat(false)
    expect(container.querySelector('#chat-launch-default')).toBeNull()
    expect(container.querySelector('#chat-agent-launch')).toBeNull()
  })

  it('finds the per-agent launch choices in Chat search and palette navigation', () => {
    useAppStore.setState({ settingsSearchQuery: 'Default launch mode per agent' })
    const { container } = renderChat()
    expect(container.querySelector('#chat-agent-launch')).toBeTruthy()
    expect(container.querySelector('#chat-appearance')).toBeNull()
    const sections = buildSettingsNavigationMetadata({
      isMac: true,
      isWindows: false,
      isWebClient: false,
      repos: []
    })
    const result = buildCmdJSettingsResults(sections).find(
      (entry) => entry.targetSectionId === 'chat-agent-launch'
    )
    expect(result?.sectionId).toBe('chat')
    expect(getSettingsScrollTarget('chat-agent-launch', container)).toBeTruthy()
  })
  it('shows the whole page when searching for its localized chat title', async () => {
    i18n.addResourceBundle('ja', 'translation', ja, true, true)
    await i18n.changeLanguage('ja')
    useAppStore.setState({ settingsSearchQuery: 'チャット' })
    const sections = buildSettingsNavigationMetadata({
      isMac: true,
      isWindows: false,
      isWebClient: false,
      repos: []
    })
    const chat = sections.find((section) => section.id === 'chat')
    expect(chat?.title).toBe('チャット UI')
    expect(chat && matchesSettingsSearch('チャット', getSettingsSectionSearchEntries(chat))).toBe(
      true
    )
    const { container } = renderChat()
    expect(container.querySelector('#chat-appearance')).toBeTruthy()
    expect(container.querySelector('#chat-text-size')).toBeTruthy()
    expect(container.querySelector('#chat-names')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'オンにする' })).toBeTruthy()
  })

  it('shows shared launch choices above Appearance without changing existing settings', () => {
    const { container, updateSettings } = renderChat(true, false, {
      agentDefaultSurface: 'terminal',
      nativeChatProviders: { claude: true }
    })
    expect(screen.getByRole('button', { name: 'Turn on' })).toBeTruthy()
    expect(screen.getByText('Chat UI is off')).toBeTruthy()
    expect(
      screen
        .getByRole('radiogroup', { name: 'Open Claude as' })
        .querySelector('[aria-checked="true"]')?.textContent
    ).toBe('Chat')
    expect(
      screen
        .getByRole('radiogroup', { name: 'Open Codex as' })
        .querySelector('[aria-checked="true"]')?.textContent
    ).toBe('CLI')
    expect(
      [
        ...container.querySelectorAll('#chat-launch-default, #chat-agent-launch, #chat-appearance')
      ].map((element) => element.id)
    ).toEqual(['chat-launch-default', 'chat-agent-launch', 'chat-appearance'])
    expect(updateSettings).not.toHaveBeenCalled()
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
    useAppStore.setState({ settingsSearchQuery: 'unrelated setting' })
    rerender(element())
    expect(screen.getByDisplayValue('Unsaved: {firstPrompt}')).toBe(template)
    expect(screen.getByRole('button', { name: 'Save' })).toBeTruthy()
    expect(container.querySelector('#chat-names')).toBeTruthy()
    expect(container.querySelector('#chat-appearance')).toBeNull()
  })

  it('searches a moved row and resolves its deep link within the Chat page', () => {
    useAppStore.setState({ settingsSearchQuery: 'Code text size' })
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
    useAppStore.setState({ settingsSearchQuery: '' })
    rerender(element())
    for (const entry of getChatAppearanceSearchEntries().filter((entry) => entry.targetSectionId)) {
      expect(getSettingsScrollTarget(entry.targetSectionId ?? '', container)).toBeTruthy()
    }
  })
})
