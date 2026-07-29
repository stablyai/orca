import { describe, expect, it, vi } from 'vitest'

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string) => fallback
}))

import { getResourceMemoryMetricCopy } from './resource-memory-metric-copy'

describe('resource memory metric copy', () => {
  it('discloses that Unix RSS sums can repeat shared and aliased pages', () => {
    expect(getResourceMemoryMetricCopy('rss')).toEqual({
      columnLabel: 'RSS',
      summaryLabel: 'Σ RSS',
      description:
        'Summed resident set size (RSS). Shared or aliased pages can appear in more than one process.'
    })
  })

  it('uses working-set terminology for Windows snapshots', () => {
    expect(getResourceMemoryMetricCopy('working-set')).toEqual({
      columnLabel: 'WS',
      summaryLabel: 'Σ WS',
      description: 'Summed working set (WS). Shared pages can appear in more than one process.'
    })
  })
})
