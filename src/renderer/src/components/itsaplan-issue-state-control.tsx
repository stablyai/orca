import { useState } from 'react'
import { toast } from 'sonner'
import { useAppStore } from '@/store'
import { useTranslate } from '@/i18n/use-translate'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import type {
  ItsaplanColumn,
  ItsaplanIssue,
  ItsaplanIssueUpdate
} from '../../../shared/itsaplan/itsaplan-types'

export function useItsaplanIssueUpdate(
  issue: Pick<ItsaplanIssue, 'id' | 'projectRef'>
): [pending: boolean, update: (updates: ItsaplanIssueUpdate) => void] {
  const t = useTranslate()
  const updateItsaplanIssue = useAppStore((s) => s.updateItsaplanIssue)
  const loadItsaplanIssueDetail = useAppStore((s) => s.loadItsaplanIssueDetail)
  const [pending, setPending] = useState(false)
  const update = (updates: ItsaplanIssueUpdate): void => {
    setPending(true)
    void updateItsaplanIssue(issue.id, updates, issue.projectRef)
      .then((result) => {
        if (!result.ok) {
          toast.error(result.message)
          return
        }
        return loadItsaplanIssueDetail(issue.id, {
          force: true,
          projectRef: issue.projectRef
        }).then(() => undefined)
      })
      .catch(() => {
        toast.error(t('taskProviders.itsaplan.updateFailed', 'Failed to update the issue.'))
      })
      .finally(() => setPending(false))
  }
  return [pending, update]
}

export function ItsaplanIssueStateControl({
  issue,
  columns
}: {
  issue: ItsaplanIssue
  columns: readonly ItsaplanColumn[]
}): React.JSX.Element {
  const t = useTranslate()
  const [pending, update] = useItsaplanIssueUpdate(issue)
  const sortedColumns = [...columns].sort((a, b) => a.position - b.position)
  const knownColumn = sortedColumns.some((column) => column.id === issue.state.columnId)
  return (
    <Select
      value={String(issue.state.columnId)}
      onValueChange={(value) => update({ columnId: Number(value) })}
      disabled={pending || sortedColumns.length === 0}
    >
      <SelectTrigger
        size="sm"
        density="compact"
        className="w-full"
        aria-label={t('auto.components.TaskPage.154b0fa623', 'Status')}
      >
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {knownColumn ? null : (
          <SelectItem value={String(issue.state.columnId)} disabled>
            {issue.state.name}
          </SelectItem>
        )}
        {sortedColumns.map((column) => (
          <SelectItem key={column.id} value={String(column.id)}>
            {column.name}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}
