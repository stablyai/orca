import { describe, expect, it } from 'vitest'
import {
  assertAutomationLaunchPreferences,
  automationLaunchPreferenceStartupProps,
  automationLaunchPreferencesEqual,
  automationLaunchPreferencesToSessionOptions,
  normalizeAutomationLaunchPreferences
} from './automation-launch-preferences'

describe('automation launch preferences', () => {
  it('normalizes persisted values and converts them to launch session options', () => {
    expect(
      normalizeAutomationLaunchPreferences({ model: ' gpt-5.6-sol ', effort: ' high ' })
    ).toEqual({ model: 'gpt-5.6-sol', effort: 'high' })
    expect(
      automationLaunchPreferencesToSessionOptions({ model: 'gpt-5.6-sol', effort: 'high' })
    ).toEqual({ model: 'gpt-5.6-sol', effort: 'high' })
    expect(automationLaunchPreferenceStartupProps({ model: 'gpt-5.6-sol' })).toEqual({
      sessionOptions: { model: 'gpt-5.6-sol' },
      sessionOptionsOverrideAgentArgs: true
    })
  })

  it('rejects effort without a model and providers without structured launch options', () => {
    expect(() => assertAutomationLaunchPreferences('codex', { effort: 'high' })).toThrow(
      'requires a model'
    )
    expect(() => assertAutomationLaunchPreferences('hermes', { model: 'gpt-5.6-sol' })).toThrow(
      'does not support'
    )
  })

  it('compares normalized run snapshots', () => {
    expect(
      automationLaunchPreferencesEqual(
        { model: ' gpt-5.6-sol ', effort: 'high' },
        { model: 'gpt-5.6-sol', effort: 'high' }
      )
    ).toBe(true)
    expect(
      automationLaunchPreferencesEqual(
        { model: 'gpt-5.6-sol', effort: 'high' },
        { model: 'gpt-5.6-sol', effort: 'low' }
      )
    ).toBe(false)
  })
})
