// @vitest-environment happy-dom
// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
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
import { getChatTurnActivitySearchEntries } from './chat-turn-activity-search'
import { AGENT_SESSION_QUEUED_MESSAGES_RUNTIME_CAPABILITY } from '../../../../../shared/agent-session/agent-session-runtime-capabilities'
import { setLocalRuntimeCapabilitiesForTests } from '@/runtime/local-runtime-capabilities'
import { i18n } from '@/i18n/i18n'
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
          ...getChatTurnActivitySearchEntries(),
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
})
