import type { GroupHeaderRow } from '../../../../../../shared/sidebar-list/row-types'
import { normalizeUsagePercentageDisplay } from '../../../../../../shared/agent-usage/display/usage-percentage-display'
import { useAppStore } from '@/store'
import { ProviderSegment } from '@/components/status-bar/usage/StatusBarProviderSegment'
import { claudeBoundGroupId } from './group-header-detail-lines'
import { useProjectGroupClaudeAccount } from './project-group-claude-account'

/** Usage of the Claude account a group runs on, under the group's name, as the status bar shows it. */
export function ProjectGroupClaudeAccountLine({
  row
}: {
  row: GroupHeaderRow
}): React.JSX.Element | null {
  const groupId = claudeBoundGroupId(row)
  return groupId ? <BoundGroupUsage groupId={groupId} /> : null
}

function BoundGroupUsage({ groupId }: { groupId: string }): React.JSX.Element {
  const account = useProjectGroupClaudeAccount(groupId, 'local')
  const display = normalizeUsagePercentageDisplay(
    useAppStore((state) => state.usagePercentageDisplay)
  )
  return (
    // Why h-4: the row's height is estimated from one fixed line.
    <div className="flex h-4 min-w-0 items-center overflow-hidden whitespace-nowrap text-xs font-normal text-muted-foreground">
      {/* Why compact: the sidebar has no room for the status bar's mini bar. */}
      <ProviderSegment p={account?.usage ?? null} compact display={display} />
    </div>
  )
}
