import { describe, expect, it } from 'vitest'

import { normalizeSupportedUiLocale, resolveUiLocale } from './ui-locale'
import {
  UI_LANGUAGE_CHINESE,
  UI_LANGUAGE_CHINESE_TRADITIONAL,
  UI_LANGUAGE_ENGLISH,
  UI_LANGUAGE_FRENCH,
  UI_LANGUAGE_JAPANESE,
  UI_LANGUAGE_KOREAN,
  UI_LANGUAGE_SPANISH,
  UI_LANGUAGE_SYSTEM
} from './ui-language'

describe('ui-locale', () => {
  it('normalizes supported locale prefixes', () => {
    expect(normalizeSupportedUiLocale('en-US')).toBe('en')
    expect(normalizeSupportedUiLocale('zh-CN')).toBe('zh')
    expect(normalizeSupportedUiLocale('zh-Hans')).toBe('zh')
    expect(normalizeSupportedUiLocale('zh-SG')).toBe('zh')
  })

  it('falls back unsupported locales to English', () => {
    expect(normalizeSupportedUiLocale('de-DE')).toBe('en')
  })

  it('maps every Traditional Chinese region and script tag to zh-Hant', () => {
    expect(normalizeSupportedUiLocale('zh-TW')).toBe('zh-Hant')
    expect(normalizeSupportedUiLocale('zh-HK')).toBe('zh-Hant')
    expect(normalizeSupportedUiLocale('zh-MO')).toBe('zh-Hant')
    expect(normalizeSupportedUiLocale('zh-Hant')).toBe('zh-Hant')
    expect(normalizeSupportedUiLocale('zh-Hant-TW')).toBe('zh-Hant')
    expect(normalizeSupportedUiLocale('zh_TW')).toBe('zh-Hant')
  })

  it('resolves explicit English independently of system locale', () => {
    expect(resolveUiLocale(UI_LANGUAGE_ENGLISH, 'zh-CN')).toBe('en')
  })

  it('resolves explicit Chinese independently of system locale', () => {
    expect(resolveUiLocale(UI_LANGUAGE_CHINESE, 'en-US')).toBe('zh')
  })

  it('resolves explicit Traditional Chinese independently of system locale', () => {
    expect(resolveUiLocale(UI_LANGUAGE_CHINESE_TRADITIONAL, 'en-US')).toBe('zh-Hant')
  })

  it('resolves explicit Korean independently of system locale', () => {
    expect(resolveUiLocale(UI_LANGUAGE_KOREAN, 'en-US')).toBe('ko')
  })

  it('resolves explicit Japanese independently of system locale', () => {
    expect(resolveUiLocale(UI_LANGUAGE_JAPANESE, 'en-US')).toBe('ja')
  })

  it('resolves explicit Spanish independently of system locale', () => {
    expect(resolveUiLocale(UI_LANGUAGE_SPANISH, 'en-US')).toBe('es')
  })

  it('resolves explicit French independently of system locale', () => {
    expect(resolveUiLocale(UI_LANGUAGE_FRENCH, 'en-US')).toBe('fr')
  })

  it('preserves a selected plugin language bundle id', () => {
    expect(resolveUiLocale('plugin:orca-samples.portuguese/pt-BR')).toBe(
      'plugin:orca-samples.portuguese/pt-BR'
    )
  })

  it('maps system locale to the closest supported locale', () => {
    expect(resolveUiLocale(UI_LANGUAGE_SYSTEM, 'en-GB')).toBe('en')
    expect(resolveUiLocale(UI_LANGUAGE_SYSTEM, 'zh-CN')).toBe('zh')
    expect(resolveUiLocale(UI_LANGUAGE_SYSTEM, 'zh-TW')).toBe('zh-Hant')
    expect(resolveUiLocale(UI_LANGUAGE_SYSTEM, 'ko-KR')).toBe('ko')
    expect(resolveUiLocale(UI_LANGUAGE_SYSTEM, 'ja-JP')).toBe('ja')
    expect(resolveUiLocale(UI_LANGUAGE_SYSTEM, 'es-MX')).toBe('es')
    expect(resolveUiLocale(UI_LANGUAGE_SYSTEM, 'fr-FR')).toBe('fr')
  })
})
