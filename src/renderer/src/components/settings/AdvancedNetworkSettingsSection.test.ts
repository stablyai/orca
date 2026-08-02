import { describe, expect, it } from 'vitest'
import type { GlobalSettings } from '../../../../shared/types'
import {
  createHttpProxyBypassRulesDraftState,
  createHttpProxyUrlDraftState,
  hasConfiguredNetworkProxy,
  setHttpProxyUrlDraftErrorState,
  shouldOpenNetworkProxyConfig,
  updateHttpProxyBypassRulesDraftState,
  updateHttpProxyUrlDraftState
} from './AdvancedNetworkSettingsSection'

describe('AdvancedNetworkSettingsSection proxy drafts', () => {
  it('keeps a committed proxy URL draft tied to the current persisted source', () => {
    const current = createHttpProxyUrlDraftState(undefined)

    expect(updateHttpProxyUrlDraftState(current, undefined, 'http://proxy.test:8080')).toEqual({
      sourceValue: '',
      draft: 'http://proxy.test:8080',
      error: null
    })
  })

  it('reconciles stale proxy URL state and clears errors before applying a new draft', () => {
    const current = setHttpProxyUrlDraftErrorState(
      updateHttpProxyUrlDraftState(
        createHttpProxyUrlDraftState('http://old.test:8080'),
        'http://old.test:8080',
        'bad proxy'
      ),
      'http://old.test:8080',
      'Invalid proxy URL'
    )

    expect(
      updateHttpProxyUrlDraftState(current, 'http://new.test:8080', 'http://typed.test:8080')
    ).toEqual({
      sourceValue: 'http://new.test:8080',
      draft: 'http://typed.test:8080',
      error: null
    })
  })

  it('keeps committed proxy bypass rules tied to the current persisted source', () => {
    const current = createHttpProxyBypassRulesDraftState('localhost')

    expect(
      updateHttpProxyBypassRulesDraftState(current, 'localhost', 'localhost,127.0.0.1')
    ).toEqual({
      sourceValue: 'localhost',
      draft: 'localhost,127.0.0.1'
    })
  })

  it('reconciles stale proxy bypass rules before applying a new draft', () => {
    const current = updateHttpProxyBypassRulesDraftState(
      createHttpProxyBypassRulesDraftState('localhost'),
      'localhost',
      'localhost,127.0.0.1'
    )

    expect(updateHttpProxyBypassRulesDraftState(current, '*.internal', '*.corp')).toEqual({
      sourceValue: '*.internal',
      draft: '*.corp'
    })
  })
})

describe('AdvancedNetworkSettingsSection proxy disclosure', () => {
  const asSettings = (partial: Partial<GlobalSettings>): GlobalSettings => partial as GlobalSettings

  it('keeps the fields collapsed by default and with an empty search', () => {
    expect(shouldOpenNetworkProxyConfig('')).toBe(false)
    expect(hasConfiguredNetworkProxy(asSettings({}))).toBe(false)
  })

  it('reveals the fields when a proxy is already configured', () => {
    expect(hasConfiguredNetworkProxy(asSettings({ httpProxyUrl: 'http://proxy.test:8080' }))).toBe(
      true
    )
    expect(hasConfiguredNetworkProxy(asSettings({ httpProxyBypassRules: 'localhost' }))).toBe(true)
    // Whitespace-only values do not count as configured.
    expect(hasConfiguredNetworkProxy(asSettings({ httpProxyUrl: '   ' }))).toBe(false)
  })

  it('reveals the fields when the search query matches proxy terms', () => {
    expect(shouldOpenNetworkProxyConfig('proxy')).toBe(true)
    expect(shouldOpenNetworkProxyConfig('zzz-no-match')).toBe(false)
  })
})
