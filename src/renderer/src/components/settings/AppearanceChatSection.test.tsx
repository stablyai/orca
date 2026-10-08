// @vitest-environment happy-dom
import type { KeybindingOverrides } from '../../../../shared/keybindings'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { getDefaultSettings } from '../../../../shared/constants'
import { TooltipProvider } from '../ui/tooltip'
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
        contrast: 130,
        matchTerminalInterface: false,
        futureSetting: 'keep'
      }
    }
    const updateSettings = persistInMock(settings)
    render(<AppearanceChatSection settings={settings} updateSettings={updateSettings} />)
    const text = screen.getByRole('spinbutton', { name: 'Text size' })
    fireEvent.change(text, { target: { value: '14' } })
    fireEvent.blur(text)
    fireEvent.click(screen.getByRole('button', { name: 'Reset' }))
    await waitFor(() => expect(updateSettings).toHaveBeenCalledTimes(2))
    expect(mocks.state.settings?.nativeChatAppearance).toEqual({ futureSetting: 'keep' })
  })
  it('indexes each row and width choice in Chat settings search', () => {
    const entries = getChatAppearanceSearchEntries()
    for (const query of [
      'Chat',
      'Match terminal interface',
      'Contrast',
      'brighter look',
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

  it('disables only terminal-controlled rows while matching and restores saved values off', async () => {
    const settings = {
      ...getDefaultSettings('/tmp'),
      nativeChatAppearance: {
        fontSize: 18,
        codeFontSize: 16,
        contrast: 125,
        matchTerminalInterface: true
      }
    }
    const updateSettings = persistInMock(settings)
    const { rerender } = render(
      <AppearanceChatSection settings={settings} updateSettings={updateSettings} />,
      { wrapper: TooltipProvider }
    )
    expect(screen.getAllByText('Set by terminal interface.')).toHaveLength(3)
    expect(screen.getByRole('spinbutton', { name: 'Text size' }).hasAttribute('disabled')).toBe(
      true
    )
    expect(
      screen.getByRole('spinbutton', { name: 'Code text size' }).hasAttribute('disabled')
    ).toBe(true)
    expect(screen.getByRole('slider', { name: 'Contrast' }).hasAttribute('data-disabled')).toBe(
      true
    )
    expect(
      screen.getByRole('switch', { name: 'Match terminal interface' }).hasAttribute('disabled')
    ).toBe(false)
    fireEvent.click(screen.getByRole('radio', { name: 'Wide' }))
    await waitFor(() => expect(mocks.state.settings?.nativeChatAppearance?.width).toBe('wide'))
    expect(mocks.state.settings?.nativeChatAppearance).toMatchObject({
      fontSize: 18,
      codeFontSize: 16,
      contrast: 125
    })
    rerender(
      <AppearanceChatSection settings={mocks.state.settings!} updateSettings={updateSettings} />
    )
    fireEvent.click(screen.getByRole('switch', { name: 'Match terminal interface' }))
    await waitFor(() =>
      expect(mocks.state.settings?.nativeChatAppearance?.matchTerminalInterface).toBeUndefined()
    )
    rerender(
      <AppearanceChatSection settings={mocks.state.settings!} updateSettings={updateSettings} />
    )
    expect(screen.queryByText('Set by terminal interface.')).toBeNull()
    expect(screen.getByRole('spinbutton', { name: 'Text size' }).getAttribute('value')).toBe('18')
    expect(screen.getByRole('spinbutton', { name: 'Code text size' }).getAttribute('value')).toBe(
      '16'
    )
    expect(screen.getByRole('slider', { name: 'Contrast' }).getAttribute('aria-valuenow')).toBe(
      '125'
    )
    expect(screen.getByRole('radio', { name: 'Wide' }).getAttribute('aria-checked')).toBe('true')
  })

  const terminalTooltip =
    'Matching your terminal interface. Turn off Match terminal interface to change this.'
  const controlledControls = [
    ['spinbutton', 'Text size'],
    ['spinbutton', 'Code text size'],
    ['slider', 'Contrast']
  ] as const

  it.each(controlledControls)(
    'explains a matched %s "%s" on hover of its wrapper',
    async (role, name) => {
      const settings = {
        ...getDefaultSettings('/tmp'),
        nativeChatAppearance: { matchTerminalInterface: true }
      }
      render(
        <AppearanceChatSection settings={settings} updateSettings={persistInMock(settings)} />,
        { wrapper: TooltipProvider }
      )
      const trigger = screen.getByRole(role, { name }).closest('[data-slot="tooltip-trigger"]')
      expect(trigger).not.toBeNull()
      fireEvent.pointerMove(trigger!, { pointerType: 'mouse' })
      expect((await screen.findByRole('tooltip')).textContent).toBe(terminalTooltip)
      // Width stays editable and unexplained.
      expect(
        screen.getByRole('radio', { name: 'Wide' }).closest('[data-slot="tooltip-trigger"]')
      ).toBeNull()
    }
  )

  it('gives the controls no tooltip while matching is off', () => {
    const settings = getDefaultSettings('/tmp')
    render(<AppearanceChatSection settings={settings} updateSettings={persistInMock(settings)} />, {
      wrapper: TooltipProvider
    })
    for (const [role, name] of controlledControls) {
      const control = screen.getByRole(role, { name })
      expect(control.closest('[data-slot="tooltip-trigger"]')).toBeNull()
      fireEvent.pointerMove(control, { pointerType: 'mouse' })
    }
    expect(screen.queryByRole('tooltip')).toBeNull()
  })
})
