import type React from 'react'
import { Plus } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Checkbox } from '@/components/ui/checkbox'
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
import type { WorkLogProvider } from '../../../../shared/work-log-types'
import { WORK_LOG_PROVIDER_OPTIONS, type WorkLogDraft } from './work-log-page-data'

export function WorkLogEntryFormCard({
  draft,
  onDraftChange,
  onSubmit
}: {
  draft: WorkLogDraft
  onDraftChange: (updater: (current: WorkLogDraft) => WorkLogDraft) => void
  onSubmit: (event: React.FormEvent<HTMLFormElement>) => void
}): React.JSX.Element {
  return (
    <Card className="border-border/60">
      <CardHeader className="pb-3">
        <CardTitle className="text-base">Add block</CardTitle>
        <CardDescription>
          Log a manual block, or keep the badge-derived estimate checked and adjust it when
          you have a better read on the day.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form className="grid gap-4" onSubmit={onSubmit}>
          <div className="grid gap-3 md:grid-cols-4">
            <Field label="Date" htmlFor="worklog-date">
              <Input
                id="worklog-date"
                type="date"
                value={draft.date}
                onChange={(event) => onDraftChange((current) => ({ ...current, date: event.target.value }))}
              />
            </Field>
            <Field label="Start" htmlFor="worklog-start">
              <Input
                id="worklog-start"
                type="time"
                value={draft.startTime}
                onChange={(event) =>
                  onDraftChange((current) => ({ ...current, startTime: event.target.value }))
                }
              />
            </Field>
            <Field label="End" htmlFor="worklog-end">
              <Input
                id="worklog-end"
                type="time"
                value={draft.endTime}
                onChange={(event) =>
                  onDraftChange((current) => ({ ...current, endTime: event.target.value }))
                }
              />
            </Field>
            <Field label="Source" htmlFor="worklog-source">
              <Select
                value={draft.provider}
                onValueChange={(value) =>
                  onDraftChange((current) => ({
                    ...current,
                    provider: value as WorkLogProvider
                  }))
                }
              >
                <SelectTrigger id="worklog-source" className="h-10">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {WORK_LOG_PROVIDER_OPTIONS.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      <div className="flex flex-col items-start">
                        <span>{option.label}</span>
                        <span className="text-xs text-muted-foreground">{option.description}</span>
                      </div>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
          </div>
          <Field label="Title" htmlFor="worklog-title">
            <Input
              id="worklog-title"
              placeholder="Example: Review Azure DevOps item 4832"
              value={draft.title}
              onChange={(event) =>
                onDraftChange((current) => ({ ...current, title: event.target.value }))
              }
              required
            />
          </Field>
          <div className="grid gap-3 md:grid-cols-2">
            <Field label="Reference" htmlFor="worklog-reference">
              <Input
                id="worklog-reference"
                placeholder="Issue number, ticket id, URL, or Planner card"
                value={draft.reference}
                onChange={(event) =>
                  onDraftChange((current) => ({ ...current, reference: event.target.value }))
                }
              />
            </Field>
            <Field label="Notes" htmlFor="worklog-notes">
              <Textarea
                id="worklog-notes"
                placeholder="What changed, what is blocked, or what needs a follow-up"
                value={draft.notes}
                onChange={(event) =>
                  onDraftChange((current) => ({ ...current, notes: event.target.value }))
                }
                className="min-h-[92px]"
              />
            </Field>
          </div>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <label className="flex items-center gap-2 text-sm text-muted-foreground">
              <Checkbox
                checked={draft.badgeDerived}
                onCheckedChange={(checked) =>
                  onDraftChange((current) => ({
                    ...current,
                    badgeDerived: checked === true
                  }))
                }
              />
              Badge-derived estimate
            </label>
            <Button type="submit" className="min-w-36">
              <Plus className="size-4" />
              Add block
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  )
}

function Field({
  label,
  htmlFor,
  children
}: {
  label: string
  htmlFor: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <div className="space-y-2">
      <Label htmlFor={htmlFor}>{label}</Label>
      {children}
    </div>
  )
}
