import { useId, useState } from 'react'
import type { DashboardCard } from '../../../../shared/dashboard-snapshot'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { translate } from '@/i18n/i18n'
import {
  currentTaskNote,
  hasCompletedResponse,
  taskObservation,
  taskNoteSchema,
  type DashboardTaskNote
} from './agent-task-status'

type TaskDetailsProps = {
  card: DashboardCard
  note?: DashboardTaskNote
  onSave: (card: DashboardCard, note: DashboardTaskNote) => void
}

function TaskDetailsForm({
  card,
  note,
  onSave,
  onClose
}: TaskDetailsProps & {
  onClose: () => void
}): React.JSX.Element {
  const id = useId()
  const [draft, setDraft] = useState<DashboardTaskNote>(
    () =>
      currentTaskNote(card, note) ?? {
        status: 'automatic',
        title: '',
        summary: '',
        nextStep: '',
        owner: '',
        reviewReference: '',
        observation: taskObservation(card),
        savedAt: 0
      }
  )
  const [error, setError] = useState('')
  const canVerify = hasCompletedResponse(card) && card.verdict === undefined
  const fields = [
    { key: 'title', label: translate('dashboardPopout.task.title', 'Task name'), max: 120 },
    {
      key: 'summary',
      label: translate('dashboardPopout.task.summary', 'Current status'),
      max: 240
    },
    { key: 'nextStep', label: translate('dashboardPopout.task.nextStep', 'Next step'), max: 240 },
    { key: 'owner', label: translate('dashboardPopout.task.owner', 'Who acts next'), max: 120 },
    {
      key: 'reviewReference',
      label: translate('dashboardPopout.task.reviewReference', 'Review reference'),
      max: 500
    }
  ] as const

  return (
    <form
      aria-label={translate('dashboardPopout.task.details', 'Task details')}
      className="space-y-3"
      onSubmit={(event) => {
        event.preventDefault()
        if (draft.observation !== taskObservation(card)) {
          setError(
            translate(
              'dashboardPopout.task.changed',
              'The agent state changed. Close and reopen these details before saving.'
            )
          )
          return
        }
        if (draft.status === 'verified' && (!canVerify || !draft.reviewReference.trim())) {
          setError(
            translate(
              'dashboardPopout.task.reviewRequired',
              'Record a review reference for this completed response before marking the result verified.'
            )
          )
          return
        }
        if (
          (draft.status === 'waiting-user' || draft.status === 'waiting-input') &&
          (!draft.nextStep.trim() || !draft.owner.trim())
        ) {
          setError(
            translate(
              'dashboardPopout.task.waitRequired',
              'Specify the next step and who needs to act.'
            )
          )
          return
        }
        try {
          onSave(card, taskNoteSchema.parse({ ...draft, savedAt: Date.now() }))
          onClose()
        } catch {
          setError(
            translate(
              'dashboardPopout.task.saveFailed',
              'Task details could not be saved. Keep this form open and try again.'
            )
          )
        }
      }}
    >
      <p className="text-sm font-medium">
        {translate('dashboardPopout.task.details', 'Task details')}
      </p>
      <p className="text-xs text-muted-foreground">
        {translate(
          'dashboardPopout.task.localScope',
          'Saved on this device for the current agent state. These notes do not control the agent. A new state requires a new review.'
        )}
      </p>
      <div className="space-y-1.5">
        <Label htmlFor={`${id}-status`}>
          {translate('dashboardPopout.task.outcome', 'Task state')}
        </Label>
        <Select
          value={draft.status}
          onValueChange={(value) => {
            const status = taskNoteSchema.shape.status.safeParse(value)
            if (status.success) {
              setDraft((current) => ({ ...current, status: status.data }))
            }
          }}
        >
          <SelectTrigger id={`${id}-status`} className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="automatic">
              {translate('dashboardPopout.task.automatic', 'Follow agent activity')}
            </SelectItem>
            <SelectItem value="waiting-user" disabled={card.bucket === 'working'}>
              {translate('dashboardPopout.task.needsYou', 'Waiting for you')}
            </SelectItem>
            <SelectItem
              value="waiting-input"
              disabled={card.bucket === 'working' || card.bucket === 'attention'}
            >
              {translate('dashboardPopout.task.waitingInput', 'Waiting for input')}
            </SelectItem>
            <SelectItem value="verified" disabled={!canVerify}>
              {translate('dashboardPopout.task.verified', 'Result verified')}
            </SelectItem>
          </SelectContent>
        </Select>
      </div>
      {fields.map((field) => (
        <div key={field.key} className="space-y-1.5">
          <Label htmlFor={`${id}-${field.key}`}>{field.label}</Label>
          <Input
            id={`${id}-${field.key}`}
            value={draft[field.key]}
            maxLength={field.max}
            required={field.key === 'reviewReference' && draft.status === 'verified'}
            onChange={(event) =>
              setDraft((current) => ({ ...current, [field.key]: event.target.value }))
            }
          />
        </div>
      ))}
      {draft.status === 'verified' ? (
        <p className="text-xs text-muted-foreground">
          {translate(
            'dashboardPopout.task.confirmReview',
            'Saving confirms that you checked the result against the linked review. A finished agent turn alone is not verification.'
          )}
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      ) : null}
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" size="sm" onClick={onClose}>
          {translate('common.cancel', 'Cancel')}
        </Button>
        <Button type="submit" size="sm">
          {translate('common.save', 'Save')}
        </Button>
      </div>
    </form>
  )
}

export function AgentTaskDetails(props: TaskDetailsProps): React.JSX.Element {
  const [open, setOpen] = useState(false)
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button type="button" variant="ghost" size="xs" className="self-start">
          {translate('dashboardPopout.task.details', 'Task details')}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-80 max-w-[calc(100vw-24px)]">
        <div className="max-h-[min(70vh,600px)] overflow-y-auto scrollbar-sleek">
          <TaskDetailsForm {...props} onClose={() => setOpen(false)} />
        </div>
      </PopoverContent>
    </Popover>
  )
}
