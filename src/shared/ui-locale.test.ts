import { describe, expect, it } from 'vitest'

import { normalizeSupportedUiLocale, resolveUiLocale, resolveRendererUiLocale } from './ui-locale'
import {
  UI_LANGUAGE_CHINESE,
  UI_LANGUAGE_ENGLISH,
  UI_LANGUAGE_JAPANESE,
  UI_LANGUAGE_KOREAN,
  UI_LANGUAGE_RUSSIAN,
  UI_LANGUAGE_SPANISH,
  UI_LANGUAGE_SYSTEM,
  UI_LANGUAGE_UKRAINIAN
} from './ui-language'

describe('ui-locale', () => {
  it('normalizes supported locale prefixes', () => {
    expect(normalizeSupportedUiLocale('en-US')).toBe('en')
    expect(normalizeSupportedUiLocale('zh-CN')).toBe('zh')
    expect(normalizeSupportedUiLocale('zh-Hans')).toBe('zh')
    expect(normalizeSupportedUiLocale('zh-SG')).toBe('zh')
  })

  it('normalizes Korean locale prefixes', () => {
    expect(normalizeSupportedUiLocale('ko-KR')).toBe('ko')
    expect(normalizeSupportedUiLocale('ko')).toBe('ko')
  })

  it('normalizes Japanese locale prefixes', () => {
    expect(normalizeSupportedUiLocale('ja-JP')).toBe('ja')
    expect(normalizeSupportedUiLocale('ja')).toBe('ja')
  })

  it('normalizes Spanish locale prefixes', () => {
    expect(normalizeSupportedUiLocale('es-ES')).toBe('es')
    expect(normalizeSupportedUiLocale('es-MX')).toBe('es')
    expect(normalizeSupportedUiLocale('es')).toBe('es')
  })

  it('normalizes Russian locale prefixes', () => {
    expect(normalizeSupportedUiLocale('ru-RU')).toBe('ru')
    expect(normalizeSupportedUiLocale('ru')).toBe('ru')
  })

  it('normalizes Ukrainian locale prefixes', () => {
    expect(normalizeSupportedUiLocale('uk-UA')).toBe('uk')
    expect(normalizeSupportedUiLocale('uk')).toBe('uk')
  })

  it('falls back unsupported locales to English', () => {
    expect(normalizeSupportedUiLocale('fr-FR')).toBe('en')
  })

  it('does not map Traditional Chinese to Simplified yet', () => {
    expect(normalizeSupportedUiLocale('zh-TW')).toBe('en')
    expect(normalizeSupportedUiLocale('zh-HK')).toBe('en')
    expect(normalizeSupportedUiLocale('zh-Hant')).toBe('en')
  })

  it('resolves explicit English independently of system locale', () => {
    expect(resolveUiLocale(UI_LANGUAGE_ENGLISH, 'zh-CN')).toBe('en')
  })

  it('resolves explicit Chinese independently of system locale', () => {
    expect(resolveUiLocale(UI_LANGUAGE_CHINESE, 'en-US')).toBe('zh')
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

  it('resolves explicit Russian independently of system locale', () => {
    expect(resolveUiLocale(UI_LANGUAGE_RUSSIAN, 'en-US')).toBe('ru')
  })

  it('resolves explicit Ukrainian independently of system locale', () => {
    expect(resolveUiLocale(UI_LANGUAGE_UKRAINIAN, 'en-US')).toBe('uk')
  })

  it('maps system locale to the closest supported locale', () => {
    expect(resolveUiLocale(UI_LANGUAGE_SYSTEM, 'en-GB')).toBe('en')
    expect(resolveUiLocale(UI_LANGUAGE_SYSTEM, 'zh-CN')).toBe('zh')
    expect(resolveUiLocale(UI_LANGUAGE_SYSTEM, 'ko-KR')).toBe('ko')
    expect(resolveUiLocale(UI_LANGUAGE_SYSTEM, 'ja-JP')).toBe('ja')
    expect(resolveUiLocale(UI_LANGUAGE_SYSTEM, 'es-MX')).toBe('es')
    expect(resolveUiLocale(UI_LANGUAGE_SYSTEM, 'ru-RU')).toBe('ru')
    expect(resolveUiLocale(UI_LANGUAGE_SYSTEM, 'uk-UA')).toBe('uk')
    expect(resolveUiLocale(UI_LANGUAGE_SYSTEM, 'fr-FR')).toBe('en')
  })

  it('uses renderer system locale only for the system setting', () => {
    expect(resolveRendererUiLocale(UI_LANGUAGE_ENGLISH)).toBe('en')
    expect(resolveRendererUiLocale(UI_LANGUAGE_CHINESE)).toBe('zh')
    expect(resolveRendererUiLocale(UI_LANGUAGE_KOREAN)).toBe('ko')
    expect(resolveRendererUiLocale(UI_LANGUAGE_JAPANESE)).toBe('ja')
    expect(resolveRendererUiLocale(UI_LANGUAGE_SPANISH)).toBe('es')
    expect(resolveRendererUiLocale(UI_LANGUAGE_RUSSIAN)).toBe('ru')
    expect(resolveRendererUiLocale(UI_LANGUAGE_UKRAINIAN)).toBe('uk')
  })
})
