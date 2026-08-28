import { useEffect, useMemo, useState } from 'react'
import type React from 'react'
import { LoaderCircle } from 'lucide-react'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import type {
  ExternalTask,
  ExternalTaskEditOptions,
  ExternalTaskProvider,
  ExternalTaskSelectOption
} from '../../../../shared/external-task-types'

const providerLabels: Record<ExternalTaskProvider, string> = {
  'azure-devops': 'Azure DevOps',
  planner: 'Microsoft Planner',
  ninjaone: 'NinjaOne'
}

const emptyOptions: ExternalTaskEditOptions = {
  statuses: [],
  assignees: [],
  priorities: [],
  severities: []
}

function withCurrent(
  options: ExternalTaskSelectOption[],
  value: string
): ExternalTaskSelectOption[] {
  return value && !options.some((option) => option.value === value)
    ? [{ value, label: value }, ...options]
    : options
}

export function ExternalTaskEditorDialog({
  provider,
  task,
  onClose,
  onUpdated
}: {
  provider: ExternalTaskProvider
  task: ExternalTask | null
  onClose: () => void
  onUpdated: (task: ExternalTask) => void
}): React.JSX.Element {
  const [detail, setDetail] = useState<ExternalTask | null>(null)
  const [options, setOptions] = useState(emptyOptions)
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [title, setTitle] = useState('')
  const [status, setStatus] = useState('')
  const [assignee, setAssignee] = useState('')
  const [description, setDescription] = useState('')
  const [priority, setPriority] = useState('')
  const [severity, setSeverity] = useState('')
  const [comment, setComment] = useState('')

  useEffect(() => {
    if (!task) {
      setDetail(null)
      return
    }
    setDetail(task)
    setTitle(task.title)
    setStatus(task.status)
    setAssignee(task.assigneeId ?? task.assignee ?? '')
    setDescription(task.description?.replace(/<[^>]+>/g, '') ?? '')
    setPriority(task.priority ?? '')
    setSeverity(task.severity ?? '')
    setComment('')
    setLoading(true)
    void Promise.all([
      window.api.externalTasks.detail({ provider, id: task.id }),
      window.api.externalTasks.options(provider)
    ])
      .then(([nextDetail, nextOptions]) => {
        setDetail(nextDetail)
        setOptions(nextOptions)
        setTitle(nextDetail.title)
        setStatus(nextDetail.status)
        setAssignee(nextDetail.assigneeId ?? nextDetail.assignee ?? '')
        setDescription(nextDetail.description?.replace(/<[^>]+>/g, '') ?? '')
        setPriority(nextDetail.priority ?? '')
        setSeverity(nextDetail.severity ?? '')
      })
      .catch((cause) => {
        toast.error(cause instanceof Error ? cause.message : 'Unable to load editor options.')
      })
      .finally(() => setLoading(false))
  }, [provider, task])

  const statusOptions = useMemo(() => withCurrent(options.statuses, status), [options, status])
  const assigneeOptions = useMemo(
    () =>
      provider === 'azure-devops'
        ? [
            { value: '__unassigned__', label: 'Unassigned' },
            ...withCurrent(options.assignees, assignee)
          ]
        : withCurrent(options.assignees, assignee),
    [assignee, options, provider]
  )

  const save = async (): Promise<void> => {
    if (!detail) {
      return
    }
    setSaving(true)
    try {
      const updated = await window.api.externalTasks.update({
        provider,
        id: detail.id,
        title: title.trim(),
        status,
        ...(provider === 'planner' ? {} : { assignee: assignee || null }),
        ...(provider === 'ninjaone' ? { priority, severity, comment: comment.trim() } : {}),
        ...(provider === 'ninjaone' ? {} : { description })
      })
      onUpdated(updated)
      toast.success(`${updated.identifier} updated`)
      onClose()
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : 'Unable to save changes.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={task !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-2xl">
        {detail ? (
          <>
            <DialogHeader>
              <DialogTitle>Edit {detail.identifier}</DialogTitle>
              <DialogDescription>
                Changes are saved directly to {providerLabels[provider]}.
              </DialogDescription>
            </DialogHeader>
            {loading ? (
              <div className="flex min-h-48 items-center justify-center">
                <LoaderCircle className="size-5 animate-spin text-muted-foreground" />
              </div>
            ) : (
              <div className="scrollbar-sleek max-h-[60vh] space-y-4 overflow-auto pr-1">
                <div className="space-y-2">
                  <Label htmlFor="external-task-title">Title</Label>
                  <Input id="external-task-title" value={title} onChange={(event) => setTitle(event.target.value)} />
                </div>
                <div className="grid gap-4 sm:grid-cols-2">
                  <SelectField label="Status" value={status} options={statusOptions} onChange={setStatus} />
                  {provider !== 'planner' ? (
                    <SelectField
                      label="Assignee"
                      value={assignee || (provider === 'azure-devops' ? '__unassigned__' : '')}
                      options={assigneeOptions}
                      onChange={(value) => setAssignee(value === '__unassigned__' ? '' : value)}
                    />
                  ) : null}
                  {provider === 'ninjaone' ? (
                    <>
                      <SelectField label="Priority" value={priority} options={options.priorities} onChange={setPriority} />
                      <SelectField label="Severity" value={severity} options={options.severities} onChange={setSeverity} />
                    </>
                  ) : null}
                </div>
                {provider !== 'ninjaone' ? (
                  <div className="space-y-2">
                    <Label htmlFor="external-task-description">Description</Label>
                    <Textarea id="external-task-description" value={description} onChange={(event) => setDescription(event.target.value)} className="min-h-36" />
                  </div>
                ) : (
                  <div className="space-y-2">
                    <Label htmlFor="external-task-comment">Add private comment</Label>
                    <Textarea id="external-task-comment" value={comment} onChange={(event) => setComment(event.target.value)} placeholder="Add an activity note" className="min-h-24" />
                  </div>
                )}
              </div>
            )}
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={onClose} disabled={saving}>Cancel</Button>
              <Button onClick={() => void save()} disabled={saving || loading || !title.trim()}>
                {saving ? <LoaderCircle className="animate-spin" /> : null}
                Save changes
              </Button>
            </div>
          </>
        ) : null}
      </DialogContent>
    </Dialog>
  )
}

function SelectField({
  label,
  value,
  options,
  onChange,
  placeholder
}: {
  label: string
  value: string
  options: ExternalTaskSelectOption[]
  onChange: (value: string) => void
  placeholder?: string
}): React.JSX.Element {
  return (
    <div className="space-y-2">
      <Label>{label}</Label>
      <Select value={value || undefined} onValueChange={onChange}>
        <SelectTrigger className="w-full">
          <SelectValue placeholder={placeholder ?? `Select ${label.toLowerCase()}`} />
        </SelectTrigger>
        <SelectContent>
          {options.map((option) => (
            <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  )
}
