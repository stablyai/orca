import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { GlobalSettings } from '../../../../shared/types'
import { NotificationStep } from './NotificationStep'

function createSettings(
  notificationOverrides: Partial<GlobalSettings['notifications']> = {}
): GlobalSettings {
  return {
    notifications: {
      enabled: true,
      agentTaskComplete: true,
      terminalBell: true,
      suppressWhenFocused: true,
      customSoundId: 'system',
      customSoundPath: null,
      customSoundVolume: 80,
      ...notificationOverrides
    }
  } as GlobalSettings
}

describe('NotificationStep', () => {
  it('renders sound setup without the old notification source switches', () => {
    const html = renderToStaticMarkup(
      <NotificationStep settings={createSettings()} updateSettings={vi.fn()} />
    )

    expect(html).toContain('Notification Sound')
    expect(html).toContain('role="combobox"')
    expect(html).toContain('Send Test Notification')
    expect(html).not.toContain('aria-pressed')
    expect(html).not.toContain('Agent task complete')
    expect(html).not.toContain('Terminal bell')
    expect(html).not.toContain('Set up agent features')
    expect(html).not.toContain('Connect task sources')
  })

  it('does not render an onboarding volume slider for non-system sounds', () => {
    const html = renderToStaticMarkup(
      <NotificationStep
        settings={createSettings({ customSoundId: 'two-tone' })}
        updateSettings={vi.fn()}
      />
    )

    expect(html).not.toContain('Notification sound volume')
    expect(html).not.toContain('80%')
  })
})
