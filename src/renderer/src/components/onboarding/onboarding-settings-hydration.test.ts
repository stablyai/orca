import { describe, expect, it } from 'vitest'
import { resolveOnboardingSettingsHydration } from './onboarding-settings-hydration'
import type { GlobalSettings } from '../../../../shared/types'

const settings = {
  theme: 'light',
  defaultTuiAgent: 'codex'
} as GlobalSettings

describe('resolveOnboardingSettingsHydration', () => {
  it('does nothing before settings hydrate', () => {
    expect(
      resolveOnboardingSettingsHydration({
        settings: null,
        settingsHydrated: false,
        themeInteracted: false,
        agentInteracted: false,
        currentTheme: 'dark',
        currentAgent: null
      })
    ).toBeNull()
  })

  it('does nothing after the first settings hydration pass', () => {
    expect(
      resolveOnboardingSettingsHydration({
        settings,
        settingsHydrated: true,
        themeInteracted: false,
        agentInteracted: false,
        currentTheme: 'dark',
        currentAgent: null
      })
    ).toBeNull()
  })

  it('hydrates theme and default agent when the user has not interacted', () => {
    expect(
      resolveOnboardingSettingsHydration({
        settings,
        settingsHydrated: false,
        themeInteracted: false,
        agentInteracted: false,
        currentTheme: 'dark',
        currentAgent: null
      })
    ).toEqual({
      settingsHydrated: true,
      theme: 'light',
      selectedAgent: 'codex'
    })
  })

  it('does not overwrite fields the user already changed', () => {
    expect(
      resolveOnboardingSettingsHydration({
        settings,
        settingsHydrated: false,
        themeInteracted: true,
        agentInteracted: true,
        currentTheme: 'dark',
        currentAgent: 'claude'
      })
    ).toEqual({ settingsHydrated: true })
  })

  it('does not clear an existing agent when settings have no default agent', () => {
    expect(
      resolveOnboardingSettingsHydration({
        settings: { ...settings, defaultTuiAgent: 'blank' },
        settingsHydrated: false,
        themeInteracted: false,
        agentInteracted: false,
        currentTheme: 'light',
        currentAgent: 'claude'
      })
    ).toEqual({ settingsHydrated: true })
  })

  it('skips redundant value updates when current local state already matches settings', () => {
    expect(
      resolveOnboardingSettingsHydration({
        settings,
        settingsHydrated: false,
        themeInteracted: false,
        agentInteracted: false,
        currentTheme: 'light',
        currentAgent: 'codex'
      })
    ).toEqual({ settingsHydrated: true })
  })
})
