import { describe, expect, it } from 'vitest'
import {
  bucketWindowKey,
  normalizeStatusBarUsageWindows,
  withStatusBarUsageWindows
} from './status-bar-usage-windows'

describe('normalizeStatusBarUsageWindows', () => {
  it('keeps known providers and window keys, deduplicated', () => {
    expect(
      normalizeStatusBarUsageWindows({
        claude: ['weekly', 'session', 'weekly', 'fableWeekly'],
        antigravity: [bucketWindowKey('Gemini Models · 5h')]
      })
    ).toEqual({
      claude: ['weekly', 'session', 'fableWeekly'],
      antigravity: ['bucket:Gemini Models · 5h']
    })
  })

  it('drops unknown providers, malformed keys and empty lists', () => {
    expect(
      normalizeStatusBarUsageWindows({
        notAProvider: ['weekly'],
        codex: ['hourly', 'bucket:', 42],
        kimi: [],
        gemini: 'weekly'
      })
    ).toEqual({})
  })

  it.each([null, undefined, 'weekly', ['weekly'], 7])('reads %s as no picks', (value) => {
    expect(normalizeStatusBarUsageWindows(value)).toEqual({})
  })
})

describe('withStatusBarUsageWindows', () => {
  it('replaces one provider without touching the others or the input', () => {
    const current = { claude: ['weekly' as const], codex: ['session' as const] }
    const next = withStatusBarUsageWindows(current, 'codex', ['weekly'])
    expect(next).toEqual({ claude: ['weekly'], codex: ['weekly'] })
    expect(current).toEqual({ claude: ['weekly'], codex: ['session'] })
  })

  it('removes the provider when the pick list is empty', () => {
    expect(withStatusBarUsageWindows({ codex: ['weekly'] }, 'codex', [])).toEqual({})
  })
})
