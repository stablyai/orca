import { expect, it } from 'vitest'
import { getPluginActivationState, type PluginConsentLists } from './plugin-consent-state'

it('keeps an approved required install enabled without adopting stale consent or a dev override', () => {
  const key = 'acme.theme'
  const preferences: PluginConsentLists = {
    disabledPlugins: [key],
    pluginConsents: { [key]: 'approved-release' }
  }
  const managed = { ...preferences, requiredPlugins: [key] }

  expect(getPluginActivationState(key, 'approved-release', managed)).toBe('approved')
  expect(getPluginActivationState(key, 'unreviewed-release', managed)).toBe('disabled')
  expect(getPluginActivationState(key, 'approved-release', managed, true)).toBe('disabled')
  expect(getPluginActivationState(key, 'approved-release', preferences)).toBe('disabled')
})
