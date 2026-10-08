// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getDefaultSettings } from '../../../../shared/constants'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import { ChatSettingsSection } from './ChatSettingsSection'
import { ActiveSettingsSectionProvider } from './SettingsSection'
import { getChatInlineVisualsSearchEntry } from './chat-inline-visuals-search'
import { matchesSettingsSearch } from './settings-search'
import { getSettingsScrollTarget } from './settings-navigation-foundations'
import { buildSettingsNavigationMetadata } from '@/hooks/useSettingsNavigationMetadata'
import { buildCmdJSettingsResults } from '../cmd-j/palette-results'

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

function renderChat(nativeChatInlineVisuals: boolean | undefined) {
  const settings = {
    ...getDefaultSettings('/tmp'),
    experimentalNativeChat: true,
    nativeChatInlineVisuals
  }
  state.settings = settings
  const updateSettings = vi.fn()
  return {
    ...render(
      <ActiveSettingsSectionProvider value="chat">
        <ChatSettingsSection
          settings={settings}
          updateSettings={updateSettings}
          writeSourceControlAiSettings={async () => {}}
          searchEntries={[getChatInlineVisualsSearchEntry()]}
          showDesktopOnlySettings
          isMounted
        />
      </ActiveSettingsSectionProvider>
    ),
    updateSettings
  }
}

describe('Inline visuals on the Chat settings page', () => {
  it.each([true, undefined])('defaults on for saved preference %s and turns off', (preference) => {
    expect(getDefaultSettings('/tmp').nativeChatInlineVisuals).toBe(true)
    const { updateSettings } = renderChat(preference)
    const toggle = screen.getByRole('switch', { name: 'Toggle inline visuals' })
    expect(toggle.getAttribute('aria-checked')).toBe('true')
    fireEvent.click(toggle)
    expect(updateSettings).toHaveBeenCalledWith({ nativeChatInlineVisuals: false })
  })

  it('uses saved off and turns on', () => {
    const { updateSettings } = renderChat(false)
    expect(screen.getByText(/Applies to newly started chats/)).toBeTruthy()
    const toggle = screen.getByRole('switch', { name: 'Toggle inline visuals' })
    expect(toggle.getAttribute('aria-checked')).toBe('false')
    fireEvent.click(toggle)
    expect(updateSettings).toHaveBeenCalledWith({ nativeChatInlineVisuals: true })
  })

  it.each(['inline visuals', 'charts', 'mockups'])(
    'finds %s and resolves its own Chat target',
    (query) => {
      state.settingsSearchQuery = query
      const { container } = renderChat(true)
      const toggle = screen.getByRole('switch', { name: 'Toggle inline visuals' })
      expect(screen.queryByRole('spinbutton', { name: 'Text size' })).toBeNull()
      const sections = buildSettingsNavigationMetadata({
        isMac: false,
        isWindows: false,
        isWebClient: false,
        structuredChatsInUse: true,
        repos: []
      })
      const results = buildCmdJSettingsResults(sections)
      expect(matchesSettingsSearch(query, getChatInlineVisualsSearchEntry())).toBe(true)
      const result = results.find((entry) => entry.title === 'Inline visuals')
      expect(result?.sectionId).toBe('chat')
      expect(result?.targetSectionId).toBe('chat-inline-visuals')
      expect(getSettingsScrollTarget('chat-inline-visuals', container)?.contains(toggle)).toBe(true)
      expect(results.filter((entry) => entry.title === 'Inline visuals')).toHaveLength(1)
    }
  )
})
