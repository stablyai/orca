import { describe, expect, it, vi } from 'vitest'

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string) => fallback
}))

import {
  getCommitPressureToneClass,
  getResourceCommitMetricCopy,
  getResourceMemoryMetricCopy
} from './resource-memory-metric-copy'

describe('resource memory metric copy', () => {
  it('discloses that Unix RSS sums can repeat shared and aliased pages', () => {
    expect(getResourceMemoryMetricCopy('rss')).toEqual({
      columnLabel: 'RSS',
      summaryLabel: 'Σ RSS',
      description:
        'Summed resident set size (RSS). Shared or aliased pages can appear in more than one process.'
    })
  })

  it('says working set counts only resident pages, so paged-out memory is missing', () => {
    expect(getResourceMemoryMetricCopy('working-set')).toEqual({
      columnLabel: 'WS',
      summaryLabel: 'Σ WS',
      description:
        'Summed working set (WS): pages resident in RAM right now. Shared pages can appear in more than one process, and memory Windows has paged out is not counted here.'
    })
  })

  it('labels committed bytes as a separate quantity, not a corrected working set', () => {
    expect(getResourceCommitMetricCopy()).toEqual({
      summaryLabel: 'Σ Private',
      description:
        'Summed private bytes: memory these processes have committed, counted whether it is resident or paged out. This is what the host charges against its commit limit, so it keeps rising while the working set above shrinks under paging.'
    })
  })
})

describe('commit pressure tone', () => {
  const hostTotalMemory = 16 * 1024 ** 3

  it('stays silent while tracked commit is a modest share of RAM', () => {
    expect(getCommitPressureToneClass({ privateMemory: 4 * 1024 ** 3, hostTotalMemory })).toBeNull()
  })

  it('warns at the same 60/80 thresholds the host usage bars already use', () => {
    expect(getCommitPressureToneClass({ privateMemory: 10 * 1024 ** 3, hostTotalMemory })).toBe(
      'text-yellow-500'
    )
    // The reported host: 13.4 GB committed by agents on 16 GB of RAM.
    expect(getCommitPressureToneClass({ privateMemory: 13.4 * 1024 ** 3, hostTotalMemory })).toBe(
      'text-red-500'
    )
  })

  it('stays silent for a snapshot that carries no commit figure at all', () => {
    expect(getCommitPressureToneClass({ privateMemory: undefined, hostTotalMemory })).toBeNull()
  })

  it('stays silent when the host total is unknown, rather than dividing by zero', () => {
    expect(
      getCommitPressureToneClass({ privateMemory: 8 * 1024 ** 3, hostTotalMemory: 0 })
    ).toBeNull()
  })

  it('keeps warning above 100% of RAM rather than capping the share', () => {
    expect(getCommitPressureToneClass({ privateMemory: 32 * 1024 ** 3, hostTotalMemory })).toBe(
      'text-red-500'
    )
  })
})
