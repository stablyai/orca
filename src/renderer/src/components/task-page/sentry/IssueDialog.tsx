import { useEffect, useState } from 'react'
import type {
  SentryAssignee,
  SentryEvent,
  SentryIssue,
  SentryIssuePriority,
  SentryIssueUpdate
} from '../../../../../shared/sentry-types'
import type { RuntimeSentrySettings } from '@/runtime/runtime-sentry-client'
import {
  sentryListAssignees,
  sentryListEvents,
  sentryUpdateIssue
} from '@/runtime/runtime-sentry-client'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { ScrollArea } from '@/components/ui/scroll-area'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { ExternalLink, Loader2, Play } from 'lucide-react'
import { toast } from 'sonner'

function EventDetails({ event }: { event: SentryEvent }): React.JSX.Element {
  return (
    <div className="space-y-4 rounded-md border border-border/60 bg-muted/20 p-3 text-xs">
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-muted-foreground">
        <span>{event.dateCreated}</span>
        {event.environment ? <span>Environment: {event.environment}</span> : null}
        {event.release ? <span>Release: {event.release}</span> : null}
      </div>
      {event.exceptions.map((exception) => (
        <section
          key={`${exception.type ?? 'exception'}:${exception.value ?? ''}:${exception.module ?? ''}`}
          className="space-y-2"
        >
          <h4 className="font-medium text-foreground">
            {exception.type ?? 'Exception'}
            {exception.value ? `: ${exception.value}` : ''}
          </h4>
          <div className="space-y-1 font-mono">
            {exception.frames.toReversed().map((frame) => (
              <div
                key={`${frame.module ?? ''}:${frame.filename ?? ''}:${frame.function ?? ''}:${frame.lineNo ?? ''}:${frame.columnNo ?? ''}`}
                className={frame.inApp ? 'text-foreground' : 'text-muted-foreground'}
              >
                {frame.function ?? '(anonymous)'} · {frame.filename ?? frame.module ?? 'unknown'}
                {frame.lineNo ? `:${frame.lineNo}` : ''}
                {frame.contextLine ? (
                  <div className="pl-4 text-muted-foreground">{frame.contextLine}</div>
                ) : null}
              </div>
            ))}
          </div>
        </section>
      ))}
      {event.breadcrumbs.length ? (
        <section className="space-y-2">
          <h4 className="font-medium text-foreground">Breadcrumbs</h4>
          {event.breadcrumbs.map((breadcrumb) => (
            <div
              key={`${breadcrumb.timestamp ?? ''}:${breadcrumb.category ?? ''}:${breadcrumb.type ?? ''}:${breadcrumb.message ?? ''}`}
              className="grid grid-cols-[120px_140px_1fr] gap-2 border-t border-border/40 py-1.5"
            >
              <span className="text-muted-foreground">{breadcrumb.timestamp ?? ''}</span>
              <span>{breadcrumb.category ?? breadcrumb.type ?? ''}</span>
              <span className="break-words">
                {breadcrumb.message ?? JSON.stringify(breadcrumb.data ?? {})}
              </span>
            </div>
          ))}
        </section>
      ) : null}
      {event.request ? <JsonSection title="Request" value={event.request} /> : null}
      {event.user ? <JsonSection title="User" value={event.user} /> : null}
      {Object.keys(event.contexts).length ? (
        <JsonSection title="Contexts" value={event.contexts} />
      ) : null}
    </div>
  )
}

function JsonSection({ title, value }: { title: string; value: unknown }): React.JSX.Element {
  return (
    <section className="space-y-2">
      <h4 className="font-medium text-foreground">{title}</h4>
      <pre className="scrollbar-sleek max-h-56 overflow-auto whitespace-pre-wrap break-all rounded-md bg-muted/50 p-2 font-mono text-[11px]">
        {JSON.stringify(value, null, 2)}
      </pre>
    </section>
  )
}

export function SentryIssueDialog({
  issue,
  settings,
  onClose,
  onChanged,
  onStartWork
}: {
  issue: SentryIssue | null
  settings: RuntimeSentrySettings
  onClose: () => void
  onChanged: (issue: SentryIssue) => void
  onStartWork: (issue: SentryIssue) => void
}): React.JSX.Element {
  const [events, setEvents] = useState<SentryEvent[]>([])
  const [nextCursor, setNextCursor] = useState<string | null>(null)
  const [assignees, setAssignees] = useState<SentryAssignee[]>([])
  const [loading, setLoading] = useState(false)
  const [mutating, setMutating] = useState(false)
  const issueId = issue?.id

  useEffect(() => {
    if (!issueId) {
      setEvents([])
      setNextCursor(null)
      return
    }
    let active = true
    setLoading(true)
    void Promise.all([sentryListEvents(settings, issueId), sentryListAssignees(settings)])
      .then(([page, nextAssignees]) => {
        if (!active) {
          return
        }
        setEvents(page.items)
        setNextCursor(page.nextCursor)
        setAssignees(nextAssignees)
      })
      .catch(
        (error) =>
          active &&
          toast.error(error instanceof Error ? error.message : 'Could not load Sentry events.')
      )
      .finally(() => active && setLoading(false))
    return () => {
      active = false
    }
  }, [issueId, settings])

  const mutate = async (updates: SentryIssueUpdate): Promise<void> => {
    if (!issue) {
      return
    }
    setMutating(true)
    try {
      const result = await sentryUpdateIssue(settings, issue.id, updates)
      if (!result.ok) {
        toast.error(result.error)
        return
      }
      onChanged(result.issue)
    } catch {
      toast.error('Couldn’t verify the Sentry update. Refresh the issue before retrying.')
    } finally {
      setMutating(false)
    }
  }

  return (
    <Dialog open={Boolean(issue)} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="flex h-[min(860px,90vh)] max-w-5xl flex-col overflow-hidden">
        {issue ? (
          <>
            <DialogHeader>
              <div className="flex items-start justify-between gap-4 pr-8">
                <div className="min-w-0">
                  <DialogTitle className="text-left">
                    {issue.shortId} · {issue.title}
                  </DialogTitle>
                  <p className="mt-1 text-sm text-muted-foreground">
                    {issue.project.name} · {issue.culprit}
                  </p>
                </div>
                <div className="flex shrink-0 gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => void window.api.shell.openUrl(issue.permalink)}
                  >
                    <ExternalLink className="size-4" />
                    Sentry
                  </Button>
                  <Button
                    size="sm"
                    onClick={() =>
                      onStartWork({ ...issue, latestEvent: events[0] ?? issue.latestEvent })
                    }
                  >
                    <Play className="size-4" />
                    Start work
                  </Button>
                </div>
              </div>
            </DialogHeader>
            <div className="flex flex-wrap gap-2 border-y border-border/50 py-3">
              <Select
                disabled={mutating}
                value={
                  issue.status === 'resolved' || issue.status === 'ignored'
                    ? issue.status
                    : 'unresolved'
                }
                onValueChange={(status) =>
                  void mutate({ status: status as 'resolved' | 'unresolved' | 'ignored' })
                }
              >
                <SelectTrigger className="h-8 w-36">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="unresolved">Unresolved</SelectItem>
                  <SelectItem value="resolved">Resolved</SelectItem>
                  <SelectItem value="ignored">Ignored</SelectItem>
                </SelectContent>
              </Select>
              <Select
                disabled={mutating}
                value={issue.priority ?? 'medium'}
                onValueChange={(priority) =>
                  void mutate({ priority: priority as SentryIssuePriority })
                }
              >
                <SelectTrigger className="h-8 w-32">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="low">Low</SelectItem>
                  <SelectItem value="medium">Medium</SelectItem>
                  <SelectItem value="high">High</SelectItem>
                </SelectContent>
              </Select>
              <Select
                disabled={mutating}
                value={
                  issue.assignedTo
                    ? `${issue.assignedTo.type}:${issue.assignedTo.id}`
                    : 'unassigned'
                }
                onValueChange={(assignedTo) =>
                  void mutate({ assignedTo: assignedTo === 'unassigned' ? null : assignedTo })
                }
              >
                <SelectTrigger className="h-8 w-52">
                  <SelectValue placeholder="Assignee" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="unassigned">Unassigned</SelectItem>
                  {assignees.map((assignee) => (
                    <SelectItem
                      key={`${assignee.type}:${assignee.id}`}
                      value={`${assignee.type}:${assignee.id}`}
                    >
                      {assignee.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {mutating ? (
                <Loader2 className="size-4 animate-spin self-center text-muted-foreground" />
              ) : null}
            </div>
            <ScrollArea className="min-h-0 flex-1 pr-4">
              <div className="space-y-5 py-4">
                <section className="grid grid-cols-2 gap-3 text-sm md:grid-cols-4">
                  <Stat label="Events" value={issue.count.toLocaleString()} />
                  <Stat label="Users" value={issue.userCount.toLocaleString()} />
                  <Stat label="First seen" value={issue.firstSeen} />
                  <Stat label="Last seen" value={issue.lastSeen} />
                </section>
                {issue.latestEvent ? <EventDetails event={issue.latestEvent} /> : null}
                <section className="space-y-3">
                  <h3 className="font-medium">Events</h3>
                  {loading ? (
                    <Loader2 className="size-5 animate-spin text-muted-foreground" />
                  ) : (
                    events.map((event) => <EventDetails key={event.id} event={event} />)
                  )}
                  {nextCursor ? (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() =>
                        void sentryListEvents(settings, issue.id, nextCursor).then((page) => {
                          setEvents((current) => [...current, ...page.items])
                          setNextCursor(page.nextCursor)
                        })
                      }
                    >
                      Load more events
                    </Button>
                  ) : null}
                </section>
              </div>
            </ScrollArea>
          </>
        ) : null}
      </DialogContent>
    </Dialog>
  )
}

function Stat({ label, value }: { label: string; value: string }): React.JSX.Element {
  return (
    <div className="rounded-md border border-border/50 bg-muted/20 p-2">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="mt-1 break-words font-medium">{value}</div>
    </div>
  )
}
