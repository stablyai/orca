import { AGENT_SESSION_PERMISSION_OWN_RUNTIME_CAPABILITY } from '../../../../shared/agent-session-permission-modes-capability'
// @vitest-environment happy-dom
import { cleanup, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getDefaultSettings } from '../../../../shared/constants'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import type { TuiAgent } from '../../../../shared/tui-agent'
import { decodeAgentSessionAgentsResult } from '../../../../shared/agent-session/agent-session-registered-agents'
import { ChatSettingsSection } from './ChatSettingsSection'
import { NativeChatProvidersSetting } from './NativeChatProvidersSetting'
import { TooltipProvider } from '../ui/tooltip'
import { ActiveSettingsSectionProvider } from './SettingsSection'
import { getChatAppearanceSearchEntries } from './chat-appearance-search'
import { getChatNamingSearchEntry } from './chat-naming-search'
import { getChatInlineVisualsSearchEntry } from './chat-inline-visuals-search'
import { getChatBehaviorSearchEntries } from './chat-behavior-search'
import { AGENT_SESSION_QUEUED_MESSAGES_RUNTIME_CAPABILITY } from '../../../../shared/protocol-version'
import { setLocalRuntimeCapabilitiesForTests } from '@/runtime/local-runtime-capabilities'
import { useStructuredAgentSessionHostQueuesMessages } from '@/runtime/structured-agent-session-host-capability'
import type * as HostStructuredAgentsModule from '@/runtime/host-structured-agents'
import { i18n } from '@/i18n/i18n'
import { buildSettingsNavigationMetadata } from '@/hooks/useSettingsNavigationMetadata'
import { buildCmdJSettingsResults } from '../cmd-j/palette-results'
import { isSettingsNavigationTarget } from '@/lib/settings-navigation-types'
import { getSettingsSectionId, getSettingsScrollTarget } from './settings-navigation-foundations'
import { getSettingsSectionSearchEntries, matchesSettingsSearch } from './settings-search'

const state = vi.hoisted(
  (): {
    settingsSearchQuery: string
    settings: GlobalSettings | null
    localDetectedAgentIdsByContext: Record<string, TuiAgent[] | null>
  } => ({ settingsSearchQuery: '', settings: null, localDetectedAgentIdsByContext: {} })
)
vi.mock('@/runtime/host-structured-agents', async (importOriginal) => ({
  ...(await importOriginal<typeof HostStructuredAgentsModule>()),
  readHostStructuredAgents: () =>
    decodeAgentSessionAgentsResult({ agents: [{ agent: 'grok', capabilities: {} }] }) ?? []
}))
vi.mock('@/lib/host-chat-program-acquisition', () => ({ useChatProgramFacts: () => {} }))
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
  state.localDetectedAgentIdsByContext = {}
  setLocalRuntimeCapabilitiesForTests([AGENT_SESSION_QUEUED_MESSAGES_RUNTIME_CAPABILITY])
})

function renderChat(
  enabled: boolean | undefined,
  showDesktopOnlySettings = true,
  hasUnsavedChatPromptChanges = false,
  overrides: Partial<GlobalSettings> = {}
) {
  const settings = { ...getDefaultSettings('/tmp'), experimentalNativeChat: enabled, ...overrides }
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
  it('shows each agent’s start permission and links to Agents on an own-settings host', () => {
    setLocalRuntimeCapabilitiesForTests([AGENT_SESSION_PERMISSION_OWN_RUNTIME_CAPABILITY])
    renderChat(true, true, false, {
      agentPermissionDefault: 'own',
      agentPermissionOverrides: { codex: 'auto' }
    })
    expect(screen.getByRole('button', { name: 'Settings → Agents' })).toBeDefined()
    expect(screen.getByText('Approve for me')).toBeDefined()
    expect(screen.getAllByText('Own settings').length).toBeGreaterThan(0)
    expect(screen.queryByRole('button', { name: 'Permissions Full access' })).toBeNull()
  })

  it('preserves clicked provider choices while queued saves and inventory changes settle', async () => {
    let latest = getDefaultSettings('/tmp')
    state.settings = latest
    state.localDetectedAgentIdsByContext = { host: [] }
    let finish: () => void = () => {}
    const delayed = new Promise<void>((resolve) => {
      finish = resolve
    })
    const updateSettings = vi.fn(async (updates: Partial<GlobalSettings>) => {
      await delayed
      latest = { ...latest, ...updates }
      state.settings = latest
    })
    const element = () => (
      <NativeChatProvidersSetting settings={latest} updateSettings={updateSettings} />
    )
    const { rerender } = render(element())
    const claude = screen.getByRole('switch', { name: 'Open Claude as a chat' })
    const grok = screen.getByRole('switch', { name: 'Open Grok as a chat' })
    expect(grok.getAttribute('aria-checked')).toBe('false')
    fireEvent.click(claude)
    await waitFor(() => expect(updateSettings).toHaveBeenCalledTimes(1))
    fireEvent.click(grok)
    fireEvent.click(claude)
    state.localDetectedAgentIdsByContext = { host: ['grok'] }
    rerender(element())
    expect(grok.getAttribute('aria-checked')).toBe('true')
    finish()
    await waitFor(() => expect(updateSettings).toHaveBeenCalledTimes(3))
    expect(latest.nativeChatProviders).toEqual({ claude: false, grok: true })
  })

  it.each([false, true])('displays saved provider choice %s when disabled in Agents', (on) => {
    renderChat(true, true, false, {
      nativeChatProviders: { claude: on },
      disabledTuiAgents: ['claude']
    })
    const toggle = screen.getByRole('switch', { name: 'Open Claude as a chat' })
    expect(toggle.getAttribute('aria-checked')).toBe(String(on))
    expect(toggle.hasAttribute('disabled')).toBe(true)
  })

  it('keeps Chat appearance on paired web without ineffective host naming controls or search results', () => {
    const { container } = renderChat(true, false)
    expect(screen.getByRole('spinbutton', { name: 'Text size' })).toBeTruthy()
    expect(container.querySelector('#chat-names')).toBeNull()
    expect(screen.queryByRole('switch', { name: 'Open Claude as a chat' })).toBeNull()
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
    expect(results.some((entry) => entry.targetSectionId === 'chat-providers')).toBe(false)
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

  it('holds the chat session settings that used to live under Experimental', () => {
    const { container, updateSettings } = renderChat(true)
    const behavior = container.querySelector('#chat-behavior')
    expect(screen.getByRole('heading', { name: 'Behavior', level: 3 })).toBeTruthy()
    const resume = screen.getByRole('switch', { name: 'Toggle automatic resume after a restart' })
    const shellEnv = screen.getByRole('switch', { name: 'Toggle using your shell environment' })
    expect(behavior?.contains(resume)).toBe(true)
    expect(behavior?.contains(shellEnv)).toBe(true)
    fireEvent.click(resume)
    expect(updateSettings).toHaveBeenCalledWith({ nativeChatResumeWorkOnRestart: true })
  })

  it.each([
    ['resume', 'chat-resume-on-restart'],
    ['environment variables', 'chat-shell-environment'],
    ['queue', 'chat-queue-follow-ups']
  ])('finds %s on the Chat page and resolves its deep link', (query, targetSectionId) => {
    state.settingsSearchQuery = query
    renderChat(true)
    expect(screen.queryByRole('spinbutton', { name: 'Text size' })).toBeNull()
    const sections = buildSettingsNavigationMetadata({
      isMac: true,
      isWindows: false,
      isWebClient: false,
      nativeChatEnabled: true,
      hostQueuesMessages: true,
      repos: []
    })
    const results = buildCmdJSettingsResults(sections).filter(
      (entry) => entry.targetSectionId === targetSectionId
    )
    expect(results).toHaveLength(1)
    expect(results[0]?.sectionId).toBe('chat')
  })

  it.each([false, true])(
    'keeps queue search and palette targets aligned with local support %s',
    (supported) => {
      setLocalRuntimeCapabilitiesForTests(
        supported ? [AGENT_SESSION_QUEUED_MESSAGES_RUNTIME_CAPABILITY] : []
      )
      const { result } = renderHook(() =>
        useStructuredAgentSessionHostQueuesMessages({ kind: 'local' })
      )
      const hostQueuesMessages = result.current
      const sections = buildSettingsNavigationMetadata({
        isMac: true,
        isWindows: false,
        isWebClient: false,
        nativeChatEnabled: true,
        hostQueuesMessages,
        repos: []
      })
      const chat = sections.find((section) => section.id === 'chat')
      const queueEntry = chat?.searchEntries.find(
        (entry) => entry.targetSectionId === 'chat-queue-follow-ups'
      )
      const queueResult = buildCmdJSettingsResults(sections).find(
        (entry) => entry.targetSectionId === 'chat-queue-follow-ups'
      )
      state.settingsSearchQuery = 'queue'
      const { container } = renderChat(true)
      expect(chat && matchesSettingsSearch('queue', getSettingsSectionSearchEntries(chat))).toBe(
        hostQueuesMessages
      )
      expect(Boolean(queueEntry)).toBe(hostQueuesMessages)
      expect(Boolean(queueResult)).toBe(hostQueuesMessages)
      expect(Boolean(container.querySelector('#chat-queue-follow-ups'))).toBe(hostQueuesMessages)
      expect(Boolean(container.querySelector('#chat-behavior'))).toBe(hostQueuesMessages)
      if (hostQueuesMessages) {
        expect(queueResult?.sectionId).toBe('chat')
        expect(getSettingsScrollTarget(queueResult?.targetSectionId ?? '', container)).toBe(
          container.querySelector('#chat-queue-follow-ups')
        )
        expect(screen.getByRole('switch', { name: 'Toggle queue follow-ups' })).toBeTruthy()
      }
    }
  )

  it('uses the existing French translations for moved Behavior controls', async () => {
    await i18n.changeLanguage('fr')
    const { container } = renderChat(true, true, false, {
      nativeChatInheritShellEnvironment: false,
      nativeChatShellEnvironmentVariables: ['FOO']
    })
    expect(
      screen.getByRole('switch', { name: 'Activer la reprise automatique après un redémarrage' })
    ).toBeTruthy()
    expect(
      screen.getByRole('switch', {
        name: "Activer l'utilisation de l'environnement de votre shell"
      })
    ).toBeTruthy()
    expect(screen.getByText('Variables à transmettre depuis votre shell')).toBeTruthy()
    expect(screen.getByPlaceholderText('Nom de la variable')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Ajouter' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Supprimer FOO' })).toBeTruthy()
    expect(screen.getByText(/PATH, les paramètres régionaux et SSH_AUTH_SOCK/)).toBeTruthy()
    expect(container.querySelector('#chat-behavior')?.textContent).toContain(
      'Reprendre automatiquement les discussions de travail après un redémarrage'
    )
    expect(container.querySelector('#chat-behavior')?.textContent).toContain(
      'Les chats Codex et Claude démarrent avec toutes les variables exportées'
    )
  })

  it('indexes the Behavior heading without adding a palette row for it', () => {
    state.settingsSearchQuery = 'Behavior'
    const { container } = renderChat(true)
    const sections = buildSettingsNavigationMetadata({
      isMac: true,
      isWindows: false,
      isWebClient: false,
      nativeChatEnabled: true,
      repos: []
    })
    const chat = sections.find((section) => section.id === 'chat')
    expect(chat?.searchEntries.some((entry) => entry.title === 'Behavior')).toBe(true)
    expect(chat && matchesSettingsSearch('Behavior', getSettingsSectionSearchEntries(chat))).toBe(
      true
    )
    expect(container.querySelector('#chat-behavior')).toBeTruthy()
    expect(
      screen.getByRole('switch', { name: 'Toggle automatic resume after a restart' })
    ).toBeTruthy()
    const results = buildCmdJSettingsResults(sections).filter((entry) => entry.sectionId === 'chat')
    expect(results.find((entry) => !entry.targetSectionId)?.configKeywords).toContain('behavior')
    expect(results.some((entry) => entry.targetSectionId && entry.title === 'Behavior')).toBe(false)
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
