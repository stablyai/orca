import { describe, expect, it } from 'vitest'
import type {
  ProviderRateLimits,
  RateLimitBucket
} from '../../../../../shared/agent-usage/rate-limits/rate-limit-types'
import { getWindowSections } from './provider-usage-panel'
import { shortUsageLabel, usedSections } from './usage-headline-sections'

function pool(group: string, windowName: string, windowMinutes: number): RateLimitBucket {
  return {
    name: `${group} · ${windowName}`,
    group,
    windowName,
    usedPercent: 0,
    windowMinutes,
    resetsAt: null,
    resetDescription: null
  }
}

describe('Antigravity pool labels', () => {
  it('labels pools by group and window length instead of agy remaining-limit names', () => {
    const p: ProviderRateLimits = {
      provider: 'antigravity',
      session: { usedPercent: 0, windowMinutes: 300, resetsAt: null, resetDescription: null },
      weekly: { usedPercent: 0, windowMinutes: 10_080, resetsAt: null, resetDescription: null },
      buckets: [
        pool('Gemini Models', 'Weekly Limit Remaining', 10_080),
        pool('Gemini Models', 'Five Hour Limit Remaining', 300),
        pool('Claude and GPT models', 'Weekly Limit Remaining', 10_080),
        pool('Claude and GPT models', 'Five Hour Limit Remaining', 300)
      ],
      updatedAt: 1_000,
      error: null,
      status: 'ok'
    }

    expect(getWindowSections(p).map((s) => s.label)).toEqual([
      'Gemini · Weekly',
      'Gemini · 5h',
      'Claude/GPT · Weekly',
      'Claude/GPT · 5h'
    ])
    expect(usedSections(p).map((s) => shortUsageLabel(p, s))).toEqual([
      'Gemini wk',
      'Gemini 5h',
      'Claude/GPT wk',
      'Claude/GPT 5h'
    ])
  })
})
