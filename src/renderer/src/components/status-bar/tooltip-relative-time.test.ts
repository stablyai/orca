import { describe, expect, it, vi } from 'vitest'

vi.mock('@/i18n/i18n', () => ({
  i18n: { language: 'en', isInitialized: true },
  translate: (_key: string, fallback: string, values?: Record<string, string | number>) =>
    Object.entries(values ?? {}).reduce(
      (text, [name, value]) => text.replace(`{{${name}}}`, String(value)),
      fallback
    )
}))
vi.mock('@/components/agent/icons/AgentIcon', () => ({
  AgentIcon: () => null
}))

import { translate } from '@/i18n/i18n'
import { formatTimeAgo } from './tooltip'
import { formatRelativeTime } from './usage-roster-formatting'

describe('formatTimeAgo', () => {
  it('uses the shared relative-time buckets and keeps the translator argument', () => {
    const now = 1_000_000_000
    expect(formatTimeAgo(now - 30_000, translate, now)).toBe('just now')
    expect(formatTimeAgo(now - 30_000, translate, now)).toBe(
      formatRelativeTime(now - 30_000, now)
    )
    expect(formatTimeAgo(now - 5 * 60_000, translate, now)).toBe('5m ago')
    expect(formatTimeAgo(now - 3 * 3_600_000, translate, now)).toBe('3h ago')
  })
})
