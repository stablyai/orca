import { useTranslate } from '@/i18n/use-translate'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import type { ItsaplanIssue, ItsaplanMember } from '../../../shared/itsaplan/itsaplan-types'
import { useItsaplanIssueUpdate } from './itsaplan-issue-state-control'

const UNASSIGNED = '__unassigned__'

export function ItsaplanIssueAssigneeControl({
  issue,
  members
}: {
  issue: ItsaplanIssue
  members: readonly ItsaplanMember[]
}): React.JSX.Element {
  const t = useTranslate()
  const [pending, update] = useItsaplanIssueUpdate(issue)
  const assignee = issue.assignee
  const knownAssignee = !assignee || members.some((member) => member.userId === assignee.userId)
  return (
    <Select
      value={assignee?.userId ?? UNASSIGNED}
      onValueChange={(value) => update({ assigneeUserId: value === UNASSIGNED ? null : value })}
      disabled={pending}
    >
      <SelectTrigger
        size="sm"
        density="compact"
        className="w-full"
        aria-label={t('auto.components.TaskPage.d2a876ca53', 'Assignee')}
      >
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={UNASSIGNED}>
          {t('auto.components.TaskPage.42a9160321', 'Unassigned')}
        </SelectItem>
        {assignee && !knownAssignee ? (
          <SelectItem value={assignee.userId} disabled>
            {assignee.name}
          </SelectItem>
        ) : null}
        {members.map((member) => (
          <SelectItem key={member.userId} value={member.userId}>
            {member.name}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}
