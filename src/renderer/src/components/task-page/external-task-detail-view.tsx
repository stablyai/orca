import { useCallback, useEffect, useMemo, useState } from 'react'
import type React from 'react'
import { ArrowLeft, ExternalLink, LoaderCircle, RefreshCw, Sparkles } from 'lucide-react'
import { toast } from 'sonner'

import { ExternalTaskActivityFeed } from '@/components/task-page/external-task-activity-feed'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Textarea } from '@/components/ui/textarea'
import type {
  ExternalTask,
  ExternalTaskDetail,
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

function withCurrent(options: ExternalTaskSelectOption[], value: string): ExternalTaskSelectOption[] {
  return value && !options.some((option) => option.value === value)
    ? [{ value, label: value }, ...options]
    : options
}

function formatDate(value: string | null | undefined): string | null {
  if (!value) {
    return null
  }
  const parsed = new Date(value)
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString()
}

export function ExternalTaskDetailView({
  provider,
  task,
  onBack,
  onUseTask,
  onUpdated
}: {
  provider: ExternalTaskProvider
  task: ExternalTask
  onBack: () => void
  onUseTask: (task: ExternalTask) => void
  onUpdated: (task: ExternalTask) => void
}): React.JSX.Element {
  const [detail, setDetail] = useState<ExternalTaskDetail | null>(null)
  const [options, setOptions] = useState(emptyOptions)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [title, setTitle] = useState(task.title)
  const [status, setStatus] = useState(task.status)
  const [assignee, setAssignee] = useState(task.assigneeId ?? task.assignee ?? '')
  const [description, setDescription] = useState(task.description?.replace(/<[^>]+>/g, '') ?? '')
  const [priority, setPriority] = useState(task.priority ?? '')
  const [severity, setSeverity] = useState(task.severity ?? '')
  const [comment, setComment] = useState('')

  const load = useCallback(async (): Promise<void> => {
    setLoading(true)
    try {
      const [nextDetail, nextOptions] = await Promise.all([
        window.api.externalTasks.detail({ provider, id: task.id }),
        window.api.externalTasks.options(provider)
      ])
      setDetail(nextDetail)
      setOptions(nextOptions)
      setTitle(nextDetail.title)
      setStatus(nextDetail.status)
      setAssignee(nextDetail.assigneeId ?? nextDetail.assignee ?? '')
      setDescription(nextDetail.description?.replace(/<[^>]+>/g, '') ?? '')
      setPriority(nextDetail.priority ?? '')
      setSeverity(nextDetail.severity ?? '')
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : 'Unable to load details.')
    } finally {
      setLoading(false)
    }
  }, [provider, task.id])

  useEffect(() => {
    void load()
  }, [load])

  const statusOptions = useMemo(() => withCurrent(options.statuses, status), [options.statuses, status])
  const assigneeOptions = useMemo(
    () =>
      provider === 'azure-devops'
        ? [{ value: '__unassigned__', label: 'Unassigned' }, ...withCurrent(options.assignees, assignee)]
        : withCurrent(options.assignees, assignee),
    [assignee, options.assignees, provider]
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
      setDetail(updated)
      setComment('')
      onUpdated(updated)
      toast.success(`${updated.identifier} updated`)
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : 'Unable to save changes.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="mt-3 flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-md border border-border/50 bg-muted/50 shadow-sm">
      <div className="flex flex-wrap items-center gap-3 border-b border-border/50 bg-card px-4 py-3">
        <Button variant="ghost" size="sm" onClick={onBack}>
          <ArrowLeft />
          Back
        </Button>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="truncate text-sm font-semibold">{detail?.title ?? task.title}</h2>
            <Badge variant="outline">{providerLabels[provider]}</Badge>
            <Badge variant="secondary">{detail?.status ?? task.status}</Badge>
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            {(detail ?? task).identifier}
            {detail?.updatedAt ? ` · Updated ${formatDate(detail.updatedAt)}` : ''}
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={() => onUseTask(detail ?? task)}>
          <Sparkles />
          Create workspace
        </Button>
        <Button variant="outline" size="sm" onClick={() => void window.api.shell.openUrl((detail ?? task).url)}>
          <ExternalLink />
          Open source
        </Button>
        <Button variant="ghost" size="icon-sm" onClick={() => void load()} disabled={loading} aria-label="Refresh details">
          <RefreshCw className={loading ? 'animate-spin' : undefined} />
        </Button>
      </div>

      {loading || !detail ? (
        <div className="flex flex-1 items-center justify-center">
          <LoaderCircle className="size-5 animate-spin text-muted-foreground" />
        </div>
      ) : (
        <div className="grid min-h-0 flex-1 gap-4 overflow-hidden p-4 lg:grid-cols-[minmax(0,1fr)_360px]">
          <div className="scrollbar-sleek min-h-0 overflow-auto pr-1">
            <Tabs defaultValue="overview" className="min-h-full">
              <TabsList variant="line">
                <TabsTrigger value="overview">Overview</TabsTrigger>
                <TabsTrigger value="activity">Activity</TabsTrigger>
                <TabsTrigger value="links">Links</TabsTrigger>
              </TabsList>
              <TabsContent value="overview" className="mt-4 space-y-4">
                <Card>
                  <CardHeader>
                    <CardTitle>Description</CardTitle>
                    <CardDescription>Provider-backed summary for this item.</CardDescription>
                  </CardHeader>
                  <CardContent>
                    <p className="whitespace-pre-wrap text-sm leading-6 text-foreground/90">
                      {description || 'No description provided.'}
                    </p>
                  </CardContent>
                </Card>
                {detail.checklist && detail.checklist.length > 0 ? (
                  <Card>
                    <CardHeader>
                      <CardTitle>Checklist</CardTitle>
                      <CardDescription>{detail.checklist.length} tracked items</CardDescription>
                    </CardHeader>
                    <CardContent className="space-y-2">
                      {detail.checklist.map((item) => (
                        <div key={item.id} className="flex items-center gap-3 rounded-lg border border-border/50 bg-background px-3 py-2 text-sm">
                          <Badge variant={item.completed ? 'default' : 'secondary'}>
                            {item.completed ? 'Done' : 'Open'}
                          </Badge>
                          <span className="min-w-0 flex-1 truncate">{item.title}</span>
                        </div>
                      ))}
                    </CardContent>
                  </Card>
                ) : null}
                {detail.tags && detail.tags.length > 0 ? (
                  <Card>
                    <CardHeader>
                      <CardTitle>Tags</CardTitle>
                    </CardHeader>
                    <CardContent className="flex flex-wrap gap-2">
                      {detail.tags.map((tag) => (
                        <Badge key={tag} variant="outline">
                          {tag}
                        </Badge>
                      ))}
                    </CardContent>
                  </Card>
                ) : null}
              </TabsContent>
              <TabsContent value="activity" className="mt-4">
                <ExternalTaskActivityFeed
                  activity={detail.activity ?? []}
                  emptyLabel={
                    provider === 'planner'
                      ? 'Planner does not expose an activity feed in this integration.'
                      : 'No provider activity has been returned for this item.'
                  }
                />
              </TabsContent>
              <TabsContent value="links" className="mt-4 space-y-4">
                <Card>
                  <CardHeader>
                    <CardTitle>Open in provider</CardTitle>
                    <CardDescription>Jump to the original system when you need the full console.</CardDescription>
                  </CardHeader>
                  <CardContent>
                    <Button variant="outline" onClick={() => void window.api.shell.openUrl(detail.url)}>
                      <ExternalLink />
                      Open {providerLabels[provider]}
                    </Button>
                  </CardContent>
                </Card>
                {detail.references && detail.references.length > 0 ? (
                  <Card>
                    <CardHeader>
                      <CardTitle>References</CardTitle>
                      <CardDescription>Linked resources from this task.</CardDescription>
                    </CardHeader>
                    <CardContent className="space-y-2">
                      {detail.references.map((reference) => (
                        <button
                          key={reference.id}
                          type="button"
                          className="flex w-full items-center justify-between rounded-lg border border-border/50 bg-background px-3 py-3 text-left transition-colors hover:bg-accent/50"
                          onClick={() => reference.url && void window.api.shell.openUrl(reference.url)}
                          disabled={!reference.url}
                        >
                          <div className="min-w-0">
                            <div className="truncate text-sm font-medium">{reference.title}</div>
                            {reference.subtitle ? (
                              <div className="mt-1 text-xs text-muted-foreground">{reference.subtitle}</div>
                            ) : null}
                          </div>
                          {reference.url ? <ExternalLink className="size-4 text-muted-foreground" /> : null}
                        </button>
                      ))}
                    </CardContent>
                  </Card>
                ) : null}
              </TabsContent>
            </Tabs>
          </div>

          <div className="scrollbar-sleek min-h-0 space-y-4 overflow-auto pr-1">
            <Card>
              <CardHeader>
                <CardTitle>Edit {detail.identifier}</CardTitle>
                <CardDescription>Changes save directly back to {providerLabels[provider]}.</CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
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
                    <Textarea
                      id="external-task-description"
                      value={description}
                      onChange={(event) => setDescription(event.target.value)}
                      className="min-h-36"
                    />
                  </div>
                ) : (
                  <div className="space-y-2">
                    <Label htmlFor="external-task-comment">Private comment</Label>
                    <Textarea
                      id="external-task-comment"
                      value={comment}
                      onChange={(event) => setComment(event.target.value)}
                      placeholder="Add an activity note to this ticket"
                      className="min-h-28"
                    />
                  </div>
                )}
                <Button onClick={() => void save()} disabled={saving || !title.trim()}>
                  {saving ? <LoaderCircle className="animate-spin" /> : null}
                  Save changes
                </Button>
              </CardContent>
            </Card>

            {detail.detailSections?.map((section) => (
              <Card key={section.id}>
                <CardHeader>
                  <CardTitle>{section.title}</CardTitle>
                </CardHeader>
                <CardContent className="space-y-3">
                  {section.fields.map((field) => (
                    <div key={`${section.id}:${field.label}`} className="flex items-start justify-between gap-3 border-b border-border/40 pb-3 last:border-0 last:pb-0">
                      <span className="text-sm text-muted-foreground">{field.label}</span>
                      <span className="max-w-[60%] text-right text-sm font-medium text-foreground/90">
                        {formatDate(field.value) ?? 'Not set'}
                      </span>
                    </div>
                  ))}
                </CardContent>
              </Card>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

function SelectField({
  label,
  value,
  options,
  onChange
}: {
  label: string
  value: string
  options: ExternalTaskSelectOption[]
  onChange: (value: string) => void
}): React.JSX.Element {
  return (
    <div className="space-y-2">
      <Label>{label}</Label>
      <Select value={value || undefined} onValueChange={onChange}>
        <SelectTrigger className="w-full">
          <SelectValue placeholder={`Select ${label.toLowerCase()}`} />
        </SelectTrigger>
        <SelectContent>
          {options.map((option) => (
            <SelectItem key={option.value} value={option.value}>
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  )
}
