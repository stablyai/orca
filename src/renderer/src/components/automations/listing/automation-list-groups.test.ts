import { describe, expect, it } from 'vitest'
import type { AutomationRunStatus } from '../../../../../shared/automations/history/automation-run'
import type { AutomationUsageSummary } from '../../../../../shared/automations/history/automation-usage-summary'
import { makeAutomation, makeAutomationListRow } from '../automations-page-fixtures'
import { buildAutomationListViewItems, type AutomationListViewItem } from './automation-list-view'
import {
  automationListItemNeedsAttention,
  groupAutomationListItems
} from './automation-list-groups'

function item(
  id: string,
  {
    enabled = true,
    lastRunStatus = null,
    summary = {},
    setupDecision
  }: {
    enabled?: boolean
    lastRunStatus?: AutomationRunStatus | null
    summary?: Partial<AutomationUsageSummary>
    setupDecision?: 'run'
  } = {}
): AutomationListViewItem {
  const row = makeAutomationListRow({
    automation: makeAutomation({ id, name: id, enabled, setupDecision }),
    usageSummary: {
      knownRuns: 0,
      unavailableRuns: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheTokens: 0,
      reasoningOutputTokens: 0,
      totalTokens: 0,
      estimatedCostUsd: null,
      lastRunStatus,
      ...summary
    }
  })
  return buildAutomationListViewItems({ rows: [row], externalEntries: [] })[0]
}

const noMigration = (): boolean => false

describe('automationListItemNeedsAttention', () => {
  it.each<[AutomationRunStatus, boolean]>([
    ['dispatch_failed', true],
    ['skipped_needs_interactive_auth', true],
    ['skipped_unavailable', true],
    ['completed', false],
    ['skipped_precheck', false],
    ['skipped_missed', false],
    ['pending', false],
    ['dispatching', false],
    ['dispatched', false]
  ])('an enabled automation whose last run is %s → %s', (status, expected) => {
    expect(
      automationListItemNeedsAttention(item('a', { lastRunStatus: status }), noMigration)
    ).toBe(expected)
  })

  it('flags an enabled automation that needs migration', () => {
    expect(automationListItemNeedsAttention(item('a'), () => true)).toBe(true)
  })

  it('flags an enabled automation whose last run skipped changed setup', () => {
    const skipped = item('a', { setupDecision: 'run', summary: { lastRunSetupSkipped: true } })
    expect(automationListItemNeedsAttention(skipped, noMigration)).toBe(true)
  })

  it('never flags a paused automation, even after a failed run', () => {
    const paused = item('a', { enabled: false, lastRunStatus: 'dispatch_failed' })
    expect(automationListItemNeedsAttention(paused, () => true)).toBe(false)
  })
})

describe('groupAutomationListItems', () => {
  it('orders Needs attention, Active, Paused, keeps sort order, and drops empty groups', () => {
    const items = [
      item('active-1', { lastRunStatus: 'completed' }),
      item('paused-1', { enabled: false }),
      item('failed-1', { lastRunStatus: 'dispatch_failed' }),
      item('active-2')
    ]
    const groups = groupAutomationListItems(items, (candidate) =>
      automationListItemNeedsAttention(candidate, noMigration)
    )
    expect(groups.map((group) => [group.id, group.items.map((entry) => entry.name)])).toEqual([
      ['attention', ['failed-1']],
      ['active', ['active-1', 'active-2']],
      ['paused', ['paused-1']]
    ])
    expect(groupAutomationListItems([items[0]], () => false).map((group) => group.id)).toEqual([
      'active'
    ])
  })
})
