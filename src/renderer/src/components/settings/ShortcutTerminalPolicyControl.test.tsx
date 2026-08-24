// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '../../store'
import { ShortcutTerminalPolicyControl } from './ShortcutTerminalPolicyControl'
import { matchesSettingsSearch } from './settings-search'
import { getTerminalShortcutPolicySearchEntry } from './shortcuts-search'

describe('ShortcutTerminalPolicyControl', () => {
  beforeEach(() => {
    useAppStore.setState({ settingsSearchQuery: '' })
  })

  afterEach(() => {
    cleanup()
  })

  it('persists the terminal shortcut capture notification preference independently', () => {
    const updateSettings = vi.fn()
    render(
      <ShortcutTerminalPolicyControl
        terminalShortcutPolicy="orca-first"
        terminalShortcutCaptureNotificationEnabled={false}
        updateSettings={updateSettings}
      />
    )

    const toggle = screen.getByRole('switch', {
      name: 'Show terminal shortcut capture notifications'
    })
    expect(toggle.getAttribute('aria-checked')).toBe('false')

    fireEvent.click(toggle)

    expect(updateSettings).toHaveBeenCalledWith({
      terminalShortcutCaptureNotificationEnabled: true
    })
  })

  it('makes the notification setting discoverable from settings search', () => {
    const entry = getTerminalShortcutPolicySearchEntry()

    expect(matchesSettingsSearch('notification', entry)).toBe(true)
    expect(matchesSettingsSearch('toast', entry)).toBe(true)
  })
})
