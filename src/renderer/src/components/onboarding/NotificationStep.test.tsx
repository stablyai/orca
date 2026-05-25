import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { GlobalSettings } from '../../../../shared/types'
import { NotificationStep } from './NotificationStep'

function createSettings(): GlobalSettings {
  return {
    notifications: {
      enabled: true,
      agentTaskComplete: true,
      terminalBell: true,
      suppressWhenFocused: false,
      customSoundId: 'system',
      customSoundPath: null,
      customSoundVolume: 80
    }
  } as GlobalSettings
}

describe('NotificationStep', () => {
  it('renders sound setup without the old notification source switches', () => {
    const html = renderToStaticMarkup(
      <NotificationStep settings={createSettings()} updateSettings={vi.fn()} />
    )

    expect(html).toContain('System Default')
    expect(html).toContain('Two Tone')
    expect(html).toContain('Sonar')
    expect(html).toContain('Ding')
    expect(html).toContain('Send Test Notification')
    expect(html).not.toContain('Agent task complete')
    expect(html).not.toContain('Terminal bell')
    expect(html).not.toContain('Set up agent features')
    expect(html).not.toContain('Connect task sources')
  })
})
