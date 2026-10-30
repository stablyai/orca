// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { getDefaultSettings } from '../../../../shared/constants'
import { ChatTransientErrorRecoverySetting } from './ChatTransientErrorRecoverySetting'
import { getChatTransientErrorRecoverySearchEntry } from './chat-transient-error-recovery-search'
import { matchesSettingsSearch } from './settings-search'
import { buildSettingsNavigationMetadata } from '@/hooks/useSettingsNavigationMetadata'

afterEach(cleanup)

describe('temporary provider error recovery setting', () => {
  it.each([false, undefined])('requires opting in for saved preference %s', (preference) => {
    const settings = getDefaultSettings('/tmp')
    expect(settings.nativeChatAutoContinueOnTransientError).toBe(false)
    const updateSettings = vi.fn()
    render(
      <ChatTransientErrorRecoverySetting
        settings={{ ...settings, nativeChatAutoContinueOnTransientError: preference }}
        updateSettings={updateSettings}
        forceVisible
      />
    )
    const toggle = screen.getByRole('switch', {
      name: 'Toggle automatic continuation after temporary errors'
    })
    expect(toggle.getAttribute('aria-checked')).toBe('false')
    fireEvent.click(toggle)
    expect(updateSettings).toHaveBeenCalledWith({ nativeChatAutoContinueOnTransientError: true })
  })

  it('can disable an enabled preference', () => {
    const updateSettings = vi.fn()
    render(
      <ChatTransientErrorRecoverySetting
        settings={{ ...getDefaultSettings('/tmp'), nativeChatAutoContinueOnTransientError: true }}
        updateSettings={updateSettings}
        forceVisible
      />
    )
    fireEvent.click(screen.getByRole('switch'))
    expect(updateSettings).toHaveBeenCalledWith({ nativeChatAutoContinueOnTransientError: false })
  })

  it.each(['capacity', 'overloaded', 'continue', 'connection'])(
    'is discoverable by %s',
    (query) => {
      const entry = getChatTransientErrorRecoverySearchEntry()
      expect(matchesSettingsSearch(query, entry)).toBe(true)
      const chat = buildSettingsNavigationMetadata({
        isMac: false,
        isWindows: false,
        isWebClient: false,
        nativeChatEnabled: true,
        repos: []
      }).find((section) => section.id === 'chat')
      expect(chat?.searchEntries).toContainEqual(entry)
    }
  )
})
