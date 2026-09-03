import { describe, expect, it } from 'vitest'
import en from './locales/en.json'
import zhTW from './locales/zh-TW.json'

function lookup(catalog: unknown, key: string): string | undefined {
  const value = key
    .split('.')
    .reduce<unknown>(
      (node, part) =>
        node && typeof node === 'object' ? (node as Record<string, unknown>)[part] : undefined,
      catalog
    )
  return typeof value === 'string' ? value : undefined
}

const CORE_LOCALIZATION_KEYS = [
  'auto.components.terminal.pane.TerminalRemoteRuntimeReconnectBanner.retryingTitle',
  'dashboardPopout.bucket.idle',
  'dashboardPopout.bucket.empty',
  'dashboardPopout.card.you',
  'browser.loadFailure.connectionNotSecure',
  'browser.loadFailure.certificateVerificationFailed'
]

describe('Traditional Chinese core UI localization', () => {
  it('does not fall back to the English source for core review surfaces', () => {
    for (const key of CORE_LOCALIZATION_KEYS) {
      const english = lookup(en, key)
      const localized = lookup(zhTW, key)
      expect(english, `${key} missing from en.json`).toBeDefined()
      expect(localized, `${key} missing from zh-TW.json`).toBeDefined()
      expect(localized?.trim(), `${key} is empty`).not.toBe('')
      expect(localized, `${key} fell back to the English source`).not.toBe(english)
    }
  })
})
