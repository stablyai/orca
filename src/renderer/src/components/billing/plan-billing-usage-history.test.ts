import { describe, expect, it } from 'vitest'
import { translate } from '@/i18n/i18n'
import {
  topMemberRows,
  topWorkspaceRows,
  usageBarPercent,
  usageChartMaxHours,
  usageTotalLine,
  usageWindowTotalLine,
  yourUsageLine
} from './plan-billing-usage-history'
import { sampleUsageHistory, sampleUsageNames } from './plan-billing-fixtures'

const HOUR = 3600
const day = (hours: number) => ({ start: 0, seconds: hours * HOUR })

describe('usage chart scale', () => {
  it('tops the axis at the nearest clean value just above the busiest day', () => {
    expect(usageChartMaxHours([day(0)])).toBe(1)
    expect(usageChartMaxHours([day(0.4)])).toBe(1)
    expect(usageChartMaxHours([day(1.5), day(0.2)])).toBe(2)
    expect(usageChartMaxHours([day(5.2)])).toBe(6)
    expect(usageChartMaxHours([day(3)])).toBe(3)
    expect(usageChartMaxHours([day(7)])).toBe(8)
    expect(usageChartMaxHours([day(48)])).toBe(50)
    expect(usageChartMaxHours([day(120)])).toBe(200)
  })

  it('keeps any used day visible and an idle day empty', () => {
    expect(usageBarPercent(0, 10)).toBe(0)
    expect(usageBarPercent(36, 10)).toBe(2)
    expect(usageBarPercent(5 * HOUR, 10)).toBe(50)
    expect(usageBarPercent(20 * HOUR, 10)).toBe(100)
  })
})

describe('top workspaces and members', () => {
  it('names members, calls the viewer "You", and keeps unknown ids readable', () => {
    const rows = topMemberRows(sampleUsageHistory, sampleUsageNames, translate)!
    expect(rows.map((row) => row.label)).toEqual([
      'You',
      'Grace Hopper',
      'Linus Torvalds',
      'Former member',
      'Not attributed to a member'
    ])
    expect(rows[0]!.share).toBeCloseTo((18.4 / 48) * 100)
    expect(rows.at(-1)!.other).toBe(true)
  })

  it('merges unknown ids into one row after the named ones, and folds 0-hour rows into the others line', () => {
    const history = {
      ...sampleUsageHistory,
      sandboxes: {
        top: [
          { id: 'sbx_gone1', seconds: 0.6 * HOUR },
          { id: 'sbx_docs', seconds: 0.5 * HOUR },
          { id: 'sbx_gone2', seconds: 0.5 * HOUR },
          { id: 'sbx_tiny', seconds: 20 }
        ],
        otherCount: 2,
        otherSeconds: 0.4 * HOUR
      }
    }
    const rows = topWorkspaceRows(history, sampleUsageNames, translate)!
    expect(rows.map((row) => [row.label, row.seconds])).toEqual([
      ['Docs search', 0.5 * HOUR],
      ['2 deleted workspaces', 3960],
      ['3 other workspaces', 0.4 * HOUR + 20]
    ])
  })

  it('drops an others line that rounds to 0 hours', () => {
    const history = {
      ...sampleUsageHistory,
      members: { top: [{ id: 'u-grace', seconds: 2 * HOUR }], otherCount: 1, otherSeconds: 30 }
    }
    const rows = topMemberRows(history, sampleUsageNames, translate)!
    expect(rows.map((row) => row.label)).toEqual(['Grace Hopper'])
  })

  it('titles workspaces and folds the rest into one line', () => {
    const rows = topWorkspaceRows(sampleUsageHistory, sampleUsageNames, translate)!
    expect(rows.map((row) => row.label)).toEqual([
      'Checkout retries',
      'Ledger migration',
      'Docs search',
      '2 deleted workspaces',
      '4 other workspaces'
    ])
  })

  it('has no breakdown for members', () => {
    const memberView = { ...sampleUsageHistory, members: null, sandboxes: null }
    expect(topMemberRows(memberView, sampleUsageNames, translate)).toBeNull()
    expect(topWorkspaceRows(memberView, sampleUsageNames, translate)).toBeNull()
    expect(yourUsageLine(memberView, translate)).toBe(
      'You used 18.4 of your team’s 48 sandbox hours.'
    )
  })

  it('formats totals with the meter’s hours (one decimal, whole numbers bare)', () => {
    expect(usageTotalLine(48 * HOUR, translate)).toBe('48 sandbox hours')
    expect(usageTotalLine(HOUR, translate)).toBe('1 sandbox hour')
    expect(usageTotalLine(0.26 * HOUR, translate)).toBe('0.3 sandbox hours')
    expect(usageWindowTotalLine(48 * HOUR, translate)).toBe('48 sandbox hours in 30 days')
  })
})
