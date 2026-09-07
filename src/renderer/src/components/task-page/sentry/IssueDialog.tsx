import { useEffect, useRef, useState } from 'react'
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
import { translate } from '@/i18n/i18n'

function EventDetails({ event }: { event: SentryEvent }): React.JSX.Element {
  return (
    <div className="space-y-4 rounded-md border border-border/60 bg-muted/20 p-3 text-xs">
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-muted-foreground">
        <span>{event.dateCreated}</span>
        {event.environment ? (
          <span>
            {translate(
              'auto.components.task.page.sentry.IssueDialog.environment',
              'Environment: {{environment}}',
              { environment: event.environment }
            )}
          </span>
        ) : null}
        {event.release ? (
          <span>
            {translate(
              'auto.components.task.page.sentry.IssueDialog.release',
              'Release: {{release}}',
              { release: event.release }
            )}
          </span>
        ) : null}
      </div>
      {event.exceptions.map((exception) => (
        <section
          key={`${exception.type ?? 'exception'}:${exception.value ?? ''}:${exception.module ?? ''}`}
          className="space-y-2"
        >
          <h4 className="font-medium text-foreground">
            {exception.type ?? translate("auto.components.task.page.sentry.IssueDialog.99c35fd668", "Exception")}
            {exception.value ? `: ${exception.value}` : ''}
          </h4>
          <div className="space-y-1 font-mono">
            {exception.frames.toReversed().map((frame) => (
              <div
                key={`${frame.module ?? ''}:${frame.filename ?? ''}:${frame.function ?? ''}:${frame.lineNo ?? ''}:${frame.columnNo ?? ''}`}
                className={frame.inApp ? 'text-foreground' : 'text-muted-foreground'}
              >
                {frame.function ?? translate("auto.components.task.page.sentry.IssueDialog.cf6cfdbab1", "(anonymous)")} · {frame.filename ?? frame.module ?? translate("auto.components.task.page.sentry.IssueDialog.88de792616", "unknown")}
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
          <h4 className="font-medium text-foreground">{translate("auto.components.task.page.sentry.IssueDialog.c8567d99ef", "Breadcrumbs")}</h4>
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
      {event.request ? <JsonSection title={translate("auto.components.task.page.sentry.IssueDialog.68b449622e", "Request")} value={event.request} /> : null}
      {event.user ? <JsonSection title={translate("auto.components.task.page.sentry.IssueDialog.9ae09a0aa3", "User")} value={event.user} /> : null}
      {Object.keys(event.contexts).length ? (
        <JsonSection title={translate("auto.components.task.page.sentry.IssueDialog.0eb65b92f3", "Contexts")} value={event.contexts} />
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
  const [loadingMore, setLoadingMore] = useState(false)
  const [mutating, setMutating] = useState(false)
  const issueId = issue?.id
  const openIssueId = useRef(issueId)
  const eventRequestGeneration = useRef(0)
  const loadMorePending = useRef(false)
  openIssueId.current = issueId

  useEffect(() => {
    const generation = ++eventRequestGeneration.current
    loadMorePending.current = false
    setLoadingMore(false)
    if (!issueId) {
      setEvents([])
      setNextCursor(null)
      return
    }
    let active = true
    setEvents([])
    setNextCursor(null)
    setLoading(true)
    void Promise.all([sentryListEvents(settings, issueId), sentryListAssignees(settings)])
      .then(([page, nextAssignees]) => {
        if (!active || generation !== eventRequestGeneration.current) {
          return
        }
        setEvents(page.items)
        setNextCursor(page.nextCursor)
        setAssignees(nextAssignees)
      })
      .catch(
        (error) =>
          active &&
          generation === eventRequestGeneration.current &&
          toast.error(error instanceof Error ? error.message : translate("auto.components.task.page.sentry.IssueDialog.84784c841c", "Could not load Sentry events."))
      )
      .finally(
        () =>
          active && generation === eventRequestGeneration.current && setLoading(false)
      )
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
      toast.error(translate("auto.components.task.page.sentry.IssueDialog.81296c63c8", "Couldn’t verify the Sentry update. Refresh the issue before retrying."))
    } finally {
      setMutating(false)
    }
  }

  const loadMoreEvents = async (): Promise<void> => {
    if (!issue || !nextCursor || loadMorePending.current) {
      return
    }
    const generation = eventRequestGeneration.current
    const requestedIssueId = issue.id
    loadMorePending.current = true
    setLoadingMore(true)
    try {
      const page = await sentryListEvents(settings, requestedIssueId, nextCursor)
      if (
        generation !== eventRequestGeneration.current ||
        openIssueId.current !== requestedIssueId
      ) {
        return
      }
      setEvents((current) => [...current, ...page.items])
      setNextCursor(page.nextCursor)
    } catch (cause) {
      if (generation === eventRequestGeneration.current) {
        toast.error(cause instanceof Error ? cause.message : translate("auto.components.task.page.sentry.IssueDialog.c8a29ced35", "Could not load more Sentry events."))
      }
    } finally {
      if (generation === eventRequestGeneration.current) {
        loadMorePending.current = false
        setLoadingMore(false)
      }
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
                    {translate("auto.components.task.page.sentry.IssueDialog.988d5a95c9", "Sentry")}</Button>
                  <Button
                    size="sm"
                    onClick={() =>
                      onStartWork({ ...issue, latestEvent: events[0] ?? issue.latestEvent })
                    }
                  >
                    <Play className="size-4" />
                    {translate("auto.components.task.page.sentry.IssueDialog.0e84aad685", "Start work")}</Button>
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
                  <SelectItem value="unresolved">{translate("auto.components.task.page.sentry.IssueDialog.35272a9b4a", "Unresolved")}</SelectItem>
                  <SelectItem value="resolved">{translate("auto.components.task.page.sentry.IssueDialog.370d6d84de", "Resolved")}</SelectItem>
                  <SelectItem value="ignored">{translate("auto.components.task.page.sentry.IssueDialog.dd56c9ba3f", "Ignored")}</SelectItem>
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
                  <SelectItem value="low">{translate("auto.components.task.page.sentry.IssueDialog.940da58543", "Low")}</SelectItem>
                  <SelectItem value="medium">{translate("auto.components.task.page.sentry.IssueDialog.3a5949be6a", "Medium")}</SelectItem>
                  <SelectItem value="high">{translate("auto.components.task.page.sentry.IssueDialog.38f65ba46e", "High")}</SelectItem>
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
                  <SelectValue placeholder={translate("auto.components.task.page.sentry.IssueDialog.9a4ae1908e", "Assignee")} />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="unassigned">{translate("auto.components.task.page.sentry.IssueDialog.f1c1ec43e6", "Unassigned")}</SelectItem>
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
                  <Stat label={translate("auto.components.task.page.sentry.IssueDialog.1e0a3492cb", "Events")} value={issue.count.toLocaleString()} />
                  <Stat label={translate("auto.components.task.page.sentry.IssueDialog.8a51dbfd31", "Users")} value={issue.userCount.toLocaleString()} />
                  <Stat label={translate("auto.components.task.page.sentry.IssueDialog.236cba9e5c", "First seen")} value={issue.firstSeen} />
                  <Stat label={translate("auto.components.task.page.sentry.IssueDialog.7fc2dbf1cf", "Last seen")} value={issue.lastSeen} />
                </section>
                {issue.latestEvent ? <EventDetails event={issue.latestEvent} /> : null}
                <section className="space-y-3">
                  <h3 className="font-medium">{translate("auto.components.task.page.sentry.IssueDialog.1e0a3492cb", "Events")}</h3>
                  {loading ? (
                    <Loader2 className="size-5 animate-spin text-muted-foreground" />
                  ) : (
                    events.map((event) => <EventDetails key={event.id} event={event} />)
                  )}
                  {nextCursor ? (
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={loadingMore}
                      onClick={() => void loadMoreEvents()}
                    >
                      {loadingMore ? <Loader2 className="size-4 animate-spin" /> : null}
                      {translate("auto.components.task.page.sentry.IssueDialog.30efbe0085", "Load more events")}</Button>
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
