import { describe, expect, it } from 'vitest'
import { shouldShowMobileEmulatorAgentSetupGuide } from './mobile-emulator-agent-setup-visibility'

describe('shouldShowMobileEmulatorAgentSetupGuide', () => {
  it('shows while setup is incomplete on an active pane', () => {
    expect(
      shouldShowMobileEmulatorAgentSetupGuide({
        dismissed: false,
        initialProbeComplete: true,
        isActive: true,
        statusReady: true
      })
    ).toBe(true)
  })

  it('stays visible when setup is complete until the user dismisses it', () => {
    expect(
      shouldShowMobileEmulatorAgentSetupGuide({
        dismissed: false,
        initialProbeComplete: true,
        isActive: true,
        statusReady: true
      })
    ).toBe(true)
  })

  it('hides before the first probe completes or after dismissal', () => {
    expect(
      shouldShowMobileEmulatorAgentSetupGuide({
        dismissed: false,
        initialProbeComplete: false,
        isActive: true,
        statusReady: false
      })
    ).toBe(false)
    expect(
      shouldShowMobileEmulatorAgentSetupGuide({
        dismissed: true,
        initialProbeComplete: true,
        isActive: true,
        statusReady: true
      })
    ).toBe(false)
  })

  it('stays visible while Re-check or focus refresh reloads probes', () => {
    expect(
      shouldShowMobileEmulatorAgentSetupGuide({
        dismissed: false,
        initialProbeComplete: true,
        isActive: true,
        statusReady: false
      })
    ).toBe(true)
  })

  it('hides on inactive panes pre-mounted for split safety', () => {
    expect(
      shouldShowMobileEmulatorAgentSetupGuide({
        dismissed: false,
        initialProbeComplete: true,
        isActive: false,
        statusReady: true
      })
    ).toBe(false)
  })
})
