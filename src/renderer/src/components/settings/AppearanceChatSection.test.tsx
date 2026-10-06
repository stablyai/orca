// @vitest-environment happy-dom
import type { KeybindingOverrides } from '../../../../shared/keybindings'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { getDefaultSettings } from '../../../../shared/constants'
import { AppearanceChatSection } from './AppearanceChatSection'
import {
  getChatAppearanceEntriesByKey,
  getChatAppearanceSearchEntries
} from './chat-appearance-search'
import { matchesSettingsSearch } from './settings-search'

const mocks = vi.hoisted(
  (): {
    state: {
      settingsSearchQuery: string
      keybindings?: KeybindingOverrides
      settings: GlobalSettings | null
      updateSettings: (updates: Partial<GlobalSettings>) => Promise<void>
    }
    platform: NodeJS.Platform
  } => ({
    state: { settingsSearchQuery: '', settings: null, updateSettings: async () => {} },
    platform: 'linux'
  })
)

vi.mock('@/lib/shortcut-platform', () => ({ getShortcutPlatform: () => mocks.platform }))

vi.mock('../../store', () => ({
  useAppStore: Object.assign(
    (selector: (state: typeof mocks.state) => unknown) => selector(mocks.state),
    { getState: () => mocks.state }
  )
}))
afterEach(() => {
  cleanup()
  mocks.state.keybindings = undefined
  mocks.state.settings = null
  mocks.platform = 'linux'
})

function persistInMock(settings: GlobalSettings) {
  mocks.state.settings = settings
  return vi.fn(async (updates: Partial<GlobalSettings>) => {
    mocks.state.settings = { ...mocks.state.settings!, ...updates }
  })
}

describe('chat appearance settings controls', () => {
  it.each([
    { platform: 'darwin', increase: '⌘=', decrease: '⌘-' },
    { platform: 'win32', increase: 'Ctrl+=', decrease: 'Ctrl+-' },
    { platform: 'linux', increase: 'Ctrl+=', decrease: 'Ctrl+-' }
  ] as const)(
    'shows only the primary default zoom shortcuts on $platform',
    ({ platform, increase, decrease }) => {
      mocks.platform = platform
      render(
        <AppearanceChatSection settings={getDefaultSettings('/tmp')} updateSettings={vi.fn()} />
      )
      const description = `Messages, tool activity and the message box. ${increase} / ${decrease} in a chat change this too.`
      expect(screen.getByText(description)).toBeTruthy()
      expect(getChatAppearanceEntriesByKey().textSize.description).toBe(description)
    }
  )

  it.each([
    { platform: 'darwin', prefix: '⌘' },
    { platform: 'win32', prefix: 'Ctrl+' },
    { platform: 'linux', prefix: 'Ctrl+' }
  ] as const)(
    'shows only the first zoom bindings on $platform and updates after rebinding',
    ({ platform, prefix }) => {
      mocks.platform = platform
      mocks.state.keybindings = {
        'zoom.in': ['Mod+Y', 'Mod+Shift+Y'],
        'zoom.out': ['Mod+U', 'Mod+Alt+U']
      }
      const card = (
        <AppearanceChatSection settings={getDefaultSettings('/tmp')} updateSettings={vi.fn()} />
      )
      const { rerender } = render(card)
      expect(
        screen.getByText(
          `Messages, tool activity and the message box. ${prefix}Y / ${prefix}U in a chat change this too.`
        )
      ).toBeTruthy()
      mocks.state.keybindings = {
        'zoom.in': ['Mod+I', 'Mod+Shift+I'],
        'zoom.out': ['Mod+O', 'Mod+Alt+O']
      }
      rerender(
        <AppearanceChatSection settings={getDefaultSettings('/tmp')} updateSettings={vi.fn()} />
      )
      expect(
        screen.getByText(
          `Messages, tool activity and the message box. ${prefix}I / ${prefix}O in a chat change this too.`
        )
      ).toBeTruthy()
    }
  )

  it('uses derived defaults and combines quick edits to different controls', async () => {
    const updateSettings = persistInMock(getDefaultSettings('/tmp'))
    render(
      <AppearanceChatSection
        settings={getDefaultSettings('/tmp')}
        updateSettings={updateSettings}
      />
    )
    const text = screen.getByRole('spinbutton', { name: 'Text size' })
    expect(text.getAttribute('value')).toBe('14')
    fireEvent.change(text, { target: { value: '30' } })
    fireEvent.blur(text)
    const code = screen.getByRole('spinbutton', { name: 'Code text size' })
    fireEvent.change(code, { target: { value: '16' } })
    fireEvent.keyDown(code, { key: 'Enter' })
    fireEvent.click(screen.getByRole('radio', { name: 'Full' }))
    await waitFor(() => expect(updateSettings).toHaveBeenCalledTimes(3))
    expect(mocks.state.settings?.nativeChatAppearance).toEqual({
      fontSize: 20,
      codeFontSize: 16,
      width: 'full'
    })
  })
  it('resets only owned fields and preserves future settings', async () => {
    const settings = {
      ...getDefaultSettings('/tmp'),
      nativeChatAppearance: {
        fontSize: 18,
        codeFontSize: 16,
        width: 'wide' as const,
        contrast: 151
      }
    }
    const updateSettings = persistInMock(settings)
    render(<AppearanceChatSection settings={settings} updateSettings={updateSettings} />)
    const text = screen.getByRole('spinbutton', { name: 'Text size' })
    fireEvent.change(text, { target: { value: '14' } })
    fireEvent.blur(text)
    fireEvent.click(screen.getByRole('button', { name: 'Reset' }))
    await waitFor(() => expect(updateSettings).toHaveBeenCalledTimes(2))
    expect(mocks.state.settings?.nativeChatAppearance).toEqual({ contrast: 151 })
  })
  it('indexes each row and width choice in Chat settings search', () => {
    const entries = getChatAppearanceSearchEntries()
    for (const query of [
      'Chat',
      'Code text size',
      'tool output',
      'Comfortable',
      'Wide',
      'Full',
      'Reset chat appearance'
    ]) {
      expect(matchesSettingsSearch(query, entries), query).toBe(true)
    }
  })
})
