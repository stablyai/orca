import { beforeEach, describe, expect, it } from 'vitest'
import type { GlobalSettings } from '../../../../shared/types'
import { i18n, setRendererUiLanguage } from '@/i18n/i18n'
import { UI_LANGUAGE_ENGLISH, UI_LANGUAGE_SPANISH } from '../../../../shared/ui-language'
import {
  createHttpProxyBypassRulesDraftState,
  createHttpProxyUrlDraftState,
  hasConfiguredNetworkProxy,
  setHttpProxyUrlDraftErrorState,
  shouldOpenNetworkProxyConfig,
  translateProxyUrlValidationMessage,
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

describe('translateProxyUrlValidationMessage', () => {
  beforeEach(async () => {
    await i18n.changeLanguage('en')
  })

  it('returns the English fallback for every distinct validation message', () => {
    expect(translateProxyUrlValidationMessage('Proxy URL is too long.')).toBe(
      'Proxy URL is too long.'
    )
    expect(translateProxyUrlValidationMessage('Enter a valid proxy URL.')).toBe(
      'Enter a valid proxy URL.'
    )
    expect(
      translateProxyUrlValidationMessage(
        'Use an http, https, socks, socks4, or socks5 proxy URL.'
      )
    ).toBe('Use an http, https, socks, socks4, or socks5 proxy URL.')
    expect(translateProxyUrlValidationMessage('Proxy URL must include a host.')).toBe(
      'Proxy URL must include a host.'
    )
  })

  it('passes through an unrecognized message unchanged', () => {
    expect(translateProxyUrlValidationMessage('some other message')).toBe('some other message')
  })

  it('translates through i18n.t when the UI language changes', async () => {
    await setRendererUiLanguage(UI_LANGUAGE_SPANISH)
    expect(translateProxyUrlValidationMessage('Proxy URL is too long.')).not.toBe(
      'Proxy URL is too long.'
    )
    await setRendererUiLanguage(UI_LANGUAGE_ENGLISH)
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
