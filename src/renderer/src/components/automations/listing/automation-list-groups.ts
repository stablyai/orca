import type { AutomationRunStatus } from '../../../../../shared/automations/history/automation-run'
import { pendingAutomationSetupReviewFromSummary } from '../authoring/automation-setup-review'
import type { AutomationListViewItem } from './automation-list-view'

export type AutomationListGroupId = 'attention' | 'active' | 'paused'

export type AutomationListGroup = {
  id: AutomationListGroupId
  items: AutomationListViewItem[]
}

/** Last-run outcomes that need a person: the run failed, or could not start without help. */
const ATTENTION_RUN_STATUSES: ReadonlySet<AutomationRunStatus> = new Set([
  'dispatch_failed',
  'skipped_needs_interactive_auth',
  'skipped_unavailable'
])

const GROUP_ORDER: readonly AutomationListGroupId[] = ['attention', 'active', 'paused']

/**
 * Enabled automations whose last run failed, couldn't start, or that can't run until someone
 * migrates them or approves changed setup. Paused automations never need attention: nothing runs.
 */
export function automationListItemNeedsAttention(
  item: AutomationListViewItem,
  needsMigration: (item: Extract<AutomationListViewItem, { kind: 'local' }>) => boolean
): boolean {
  if (!item.enabled) {
    return false
  }
  if (item.kind === 'external') {
    return item.lastRun.tone === 'failed'
  }
  const { automation, usageSummary } = item.row
  const lastRunStatus = usageSummary?.lastRunStatus
  return (
    (lastRunStatus != null && ATTENTION_RUN_STATUSES.has(lastRunStatus)) ||
    needsMigration(item) ||
    pendingAutomationSetupReviewFromSummary(automation, usageSummary) !== null
  )
}

/** Needs attention, Active, Paused; each keeps the list's sort order and empty groups drop out. */
export function groupAutomationListItems(
  items: readonly AutomationListViewItem[],
  needsAttention: (item: AutomationListViewItem) => boolean
): AutomationListGroup[] {
  const byGroup = new Map<AutomationListGroupId, AutomationListViewItem[]>(
    GROUP_ORDER.map((id) => [id, []])
  )
  for (const item of items) {
    const id: AutomationListGroupId = !item.enabled
      ? 'paused'
      : needsAttention(item)
        ? 'attention'
        : 'active'
    byGroup.get(id)!.push(item)
  }
  return GROUP_ORDER.flatMap((id) => {
    const groupItems = byGroup.get(id)!
    return groupItems.length > 0 ? [{ id, items: groupItems }] : []
  })
}
