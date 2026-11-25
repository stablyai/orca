import type { GroupHeaderRow } from '../../../../../../shared/sidebar-list/row-types'
import { claudeBoundGroupId } from './group-header-detail-lines'
import { useProjectGroupClaudeAccount } from './project-group-claude-account'

/** The Claude account a group runs on, beside the group's name; an email shows without its domain. */
export function ProjectGroupClaudeAccountName({
  row
}: {
  row: GroupHeaderRow
}): React.JSX.Element | null {
  const groupId = claudeBoundGroupId(row)
  return groupId ? <BoundGroupAccountName groupId={groupId} /> : null
}

function BoundGroupAccountName({ groupId }: { groupId: string }): React.JSX.Element | null {
  const label = useProjectGroupClaudeAccount(groupId, 'local')?.label
  if (!label) {
    return null
  }
  const at = label.indexOf('@')
  return (
    // Why shrink-[100]: the group's own name keeps its width; the account gives way first.
    <span
      data-project-group-claude-account=""
      title={label}
      className="min-w-0 shrink-[100] truncate text-xs font-normal leading-4 text-muted-foreground"
    >
      {at > 0 ? label.slice(0, at) : label}
    </span>
  )
}
