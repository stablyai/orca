import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { TaskPageComposerActionsModel } from '../../use-task-page-composer-actions'
import type {
  SentryConnectionStatus,
  SentryEnvironment,
  SentryIssue,
  SentryPage,
  SentryProject
} from '../../../../../shared/sentry-types'
import { getSettingsFocusedExecutionHostId } from '../../../../../shared/execution-host'
import { normalizeTaskSourceContext } from '../../../../../shared/task-source-context'
import {
  sentryDisconnect,
  sentryListEnvironments,
  sentryListIssues,
  sentryListProjects,
  sentrySelectOrganization,
  sentryStatus,
  sentryTestConnection
} from '@/runtime/runtime-sentry-client'
import { SentryConnectDialog } from '@/components/sentry-connect-dialog'
import { SentryIcon } from '@/components/icons/SentryIcon'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { ChevronDown, ExternalLink, Loader2, RefreshCw } from 'lucide-react'
import { SentryIssueDialog } from './IssueDialog'
import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'

const EMPTY_PAGE: SentryPage<SentryIssue> = { items: [], nextCursor: null, previousCursor: null }

type SentryIssueListOverrides = {
  projects?: string[]
  environments?: string[]
  statsPeriod?: string
  sort?: 'date' | 'new' | 'freq' | 'user'
}

function relativeTime(value: string): string {
  const timestamp = Date.parse(value)
  if (!Number.isFinite(timestamp)) {
    return value
  }
  const minutes = Math.max(0, Math.floor((Date.now() - timestamp) / 60_000))
  if (minutes < 60) {
    return translate('auto.components.task.page.sentry.Content.minutesAgo', '{{minutes}}m ago', {
      minutes
    })
  }
  const hours = Math.floor(minutes / 60)
  return hours < 24
    ? translate('auto.components.task.page.sentry.Content.hoursAgo', '{{hours}}h ago', { hours })
    : translate('auto.components.task.page.sentry.Content.daysAgo', '{{days}}d ago', {
        days: Math.floor(hours / 24)
      })
}

function selectedLabel(selected: Set<string>, allLabel: string): string {
  return selected.size
    ? translate('auto.components.task.page.sentry.Content.selectedCount', '{{total}} selected', {
        total: selected.size
      })
    : allLabel
}

export function TaskPageSentryContent({
  model
}: {
  model: TaskPageComposerActionsModel
}): React.JSX.Element {
  const { settings, openModal, fallbackTaskSourceProjectId } = model
  const [status, setStatus] = useState<SentryConnectionStatus | null>(null)
  const [projects, setProjects] = useState<SentryProject[]>([])
  const [environments, setEnvironments] = useState<SentryEnvironment[]>([])
  const [selectedProjects, setSelectedProjects] = useState<Set<string>>(new Set())
  const [selectedEnvironments, setSelectedEnvironments] = useState<Set<string>>(new Set())
  const [query, setQuery] = useState('is:unresolved')
  const [statsPeriod, setStatsPeriod] = useState('14d')
  const [sort, setSort] = useState<'date' | 'new' | 'freq' | 'user'>('date')
  const [page, setPage] = useState(EMPTY_PAGE)
  const [selectedIssue, setSelectedIssue] = useState<SentryIssue | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [connectOpen, setConnectOpen] = useState(false)
  const issueRequestGeneration = useRef(0)
  const catalogRequestGeneration = useRef(0)

  const loadStatus = useCallback(async (): Promise<SentryConnectionStatus> => {
    const next = await sentryStatus(settings)
    setStatus(next)
    return next
  }, [settings])

  const loadIssues = useCallback(
    async (
      cursor?: string,
      overrides?: SentryIssueListOverrides
    ): Promise<void> => {
      const generation = ++issueRequestGeneration.current
      setLoading(true)
      setError(null)
      try {
        const next = await sentryListIssues(settings, {
          query,
          projects: overrides?.projects ?? [...selectedProjects],
          environments: overrides?.environments ?? [...selectedEnvironments],
          statsPeriod: overrides?.statsPeriod ?? statsPeriod,
          sort: overrides?.sort ?? sort,
          cursor,
          limit: 50
        })
        if (generation !== issueRequestGeneration.current) {
          return
        }
        setPage((current) =>
          cursor ? { ...next, items: [...current.items, ...next.items] } : next
        )
      } catch (cause) {
        if (generation === issueRequestGeneration.current) {
          setError(
            cause instanceof Error
              ? cause.message
              : translate(
                  'auto.components.task.page.sentry.Content.loadFailed',
                  'Could not load Sentry issues.'
                )
          )
        }
      } finally {
        if (generation === issueRequestGeneration.current) {
          setLoading(false)
        }
      }
    },
    [query, selectedEnvironments, selectedProjects, settings, sort, statsPeriod]
  )
  const loadIssuesRef = useRef(loadIssues)

  useEffect(() => {
    loadIssuesRef.current = loadIssues
  }, [loadIssues])

  const loadProviderData = useCallback(
    async (resetFilters = false): Promise<void> => {
      const generation = ++catalogRequestGeneration.current
      const invalidatedIssueGeneration = ++issueRequestGeneration.current
      setLoading(true)
      if (resetFilters) {
        setPage(EMPTY_PAGE)
      }
      try {
        const [nextProjects, nextEnvironments] = await Promise.all([
          sentryListProjects(settings),
          sentryListEnvironments(settings)
        ])
        if (generation !== catalogRequestGeneration.current) {
          return
        }
        setProjects(nextProjects)
        setEnvironments(nextEnvironments)
        if (resetFilters) {
          setSelectedProjects(new Set())
          setSelectedEnvironments(new Set())
        }
        await loadIssuesRef.current(
          undefined,
          resetFilters ? { projects: [], environments: [] } : undefined
        )
      } finally {
        if (
          generation === catalogRequestGeneration.current &&
          invalidatedIssueGeneration === issueRequestGeneration.current
        ) {
          setLoading(false)
        }
      }
    },
    [settings]
  )

  useEffect(() => {
    let active = true
    setLoading(true)
    void loadStatus()
      .then(async (next) => {
        if (!active || !next.connected) {
          return
        }
        await loadProviderData()
      })
      .catch(
        (cause) =>
          active &&
          setError(
            cause instanceof Error
              ? cause.message
              : translate(
                  'auto.components.task.page.sentry.Content.statusFailed',
                  'Could not read Sentry connection.'
                )
          )
      )
      .finally(() => active && setLoading(false))
    return () => {
      active = false
    }
  }, [loadProviderData, loadStatus])

  const updateIssue = (updated: SentryIssue): void => {
    setSelectedIssue(updated)
    setPage((current) => ({
      ...current,
      items: current.items.map((item) => (item.id === updated.id ? updated : item))
    }))
  }

  const startWork = (issue: SentryIssue): void => {
    const connection = status?.connection
    if (!connection) {
      return
    }
    const event = issue.latestEvent
    const frames =
      event?.exceptions.flatMap((exception) => exception.frames.filter((frame) => frame.inApp)) ??
      []
    const renderedText = [
      `Sentry issue: ${issue.shortId} ${issue.title}`,
      `URL: ${issue.permalink}`,
      `Project: ${issue.project.name}`,
      issue.culprit ? `Culprit: ${issue.culprit}` : null,
      event?.release ? `Release: ${event.release}` : null,
      event?.environment ? `Environment: ${event.environment}` : null,
      ...frames
        .slice(-20)
        .map(
          (frame) =>
            `Frame: ${frame.function ?? '(anonymous)'} at ${frame.filename ?? frame.module ?? 'unknown'}${frame.lineNo ? `:${frame.lineNo}` : ''}`
        )
    ]
      .filter((line): line is string => Boolean(line))
      .join('\n')
    const taskSourceContext = normalizeTaskSourceContext({
      provider: 'sentry',
      projectId: fallbackTaskSourceProjectId,
      hostId: getSettingsFocusedExecutionHostId(settings),
      providerIdentity: {
        provider: 'sentry',
        baseUrl: connection.baseUrl,
        organizationSlug: connection.organization.slug,
        projectSlug: issue.project.slug
      },
      accountLabel: connection.organization.name
    })
    openModal('new-workspace-composer', {
      linkedWorkItem: {
        provider: 'sentry',
        type: 'issue',
        number: 0,
        title: `${issue.shortId} ${issue.title}`,
        url: issue.permalink,
        sentryIssueId: issue.id,
        sentryShortId: issue.shortId,
        linkedContext: { provider: 'sentry', version: 1, renderedText }
      },
      taskSourceContext,
      prefilledName: `sentry-${issue.shortId.toLowerCase()}`,
      telemetrySource: 'sidebar'
    })
  }

  const connection = status?.connection
  const organizationOptions = status?.organizations ?? []
  const issueRows = useMemo(() => page.items, [page.items])

  if (!status?.connected && !loading) {
    return (
      <div className="mt-3 flex min-h-72 flex-1 flex-col items-center justify-center rounded-md border border-border/50 bg-muted/20 text-center">
        <SentryIcon className="mb-4 size-8 text-muted-foreground/60" />
        <h2 className="font-medium">{translate("auto.components.task.page.sentry.Content.78d5b2169a", "Connect Sentry")}</h2>
        <p className="mt-1 max-w-md text-sm text-muted-foreground">
          {translate("auto.components.task.page.sentry.Content.c6ed210867", "Connect an organization to browse errors, inspect events, and start workspaces.")}</p>
        {status?.credentialError ? (
          <p className="mt-2 text-sm text-destructive">{status.credentialError}</p>
        ) : null}
        <Button className="mt-4" onClick={() => setConnectOpen(true)}>
          {translate("auto.components.task.page.sentry.Content.78d5b2169a", "Connect Sentry")}</Button>
        <SentryConnectDialog
          open={connectOpen}
          onOpenChange={setConnectOpen}
          settings={settings}
          onConnected={(next) => {
            setStatus(next)
            void loadProviderData(true).catch((cause) =>
              setError(
                cause instanceof Error
                  ? cause.message
                  : translate(
                      'auto.components.task.page.sentry.Content.catalogFailed',
                      'Could not load Sentry projects and environments.'
                    )
              )
            )
          }}
        />
      </div>
    )
  }

  return (
    <div className="mt-3 flex min-h-0 flex-1 flex-col overflow-hidden rounded-md border border-border/50 bg-muted/20 shadow-sm">
      <div className="flex flex-wrap items-center gap-2 border-b border-border/50 p-2">
        {organizationOptions.length > 1 ? (
          <Select
            value={connection?.organization.slug}
            onValueChange={(slug) =>
              void sentrySelectOrganization(settings, slug)
                .then((next) => {
                  setStatus(next)
                  setPage(EMPTY_PAGE)
                  return loadProviderData(true)
                })
                .catch((cause) =>
                  setError(
                    cause instanceof Error
                      ? cause.message
                      : translate(
                          'auto.components.task.page.sentry.Content.organizationFailed',
                          'Could not change the Sentry organization.'
                        )
                  )
                )
            }
          >
            <SelectTrigger className="h-8 w-48">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {organizationOptions.map((organization) => (
                <SelectItem key={organization.id} value={organization.slug}>
                  {organization.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : null}
        <FilterMenu
          label={selectedLabel(selectedProjects, 'All projects')}
          items={projects.map((project) => ({ id: project.id, label: project.name }))}
          selected={selectedProjects}
          onChange={(next) => {
            setSelectedProjects(next)
            void loadIssues(undefined, { projects: [...next] })
          }}
        />
        <FilterMenu
          label={selectedLabel(selectedEnvironments, 'All environments')}
          items={environments.map((environment) => ({
            id: environment.name,
            label: environment.name
          }))}
          selected={selectedEnvironments}
          onChange={(next) => {
            setSelectedEnvironments(next)
            void loadIssues(undefined, { environments: [...next] })
          }}
        />
        <Select
          value={statsPeriod}
          onValueChange={(next) => {
            setStatsPeriod(next)
            void loadIssues(undefined, { statsPeriod: next })
          }}
        >
          <SelectTrigger className="h-8 w-28">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="24h">{translate("auto.components.task.page.sentry.Content.5be30b3ff0", "24 hours")}</SelectItem>
            <SelectItem value="7d">{translate("auto.components.task.page.sentry.Content.f9f4523be0", "7 days")}</SelectItem>
            <SelectItem value="14d">{translate("auto.components.task.page.sentry.Content.2f69b48145", "14 days")}</SelectItem>
            <SelectItem value="30d">{translate("auto.components.task.page.sentry.Content.a502b35389", "30 days")}</SelectItem>
          </SelectContent>
        </Select>
        <Select
          value={sort}
          onValueChange={(value) => {
            const next = value as typeof sort
            setSort(next)
            void loadIssues(undefined, { sort: next })
          }}
        >
          <SelectTrigger className="h-8 w-32">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="date">{translate("auto.components.task.page.sentry.Content.eb7d38e761", "Last seen")}</SelectItem>
            <SelectItem value="new">{translate("auto.components.task.page.sentry.Content.25b700d4a8", "First seen")}</SelectItem>
            <SelectItem value="freq">{translate("auto.components.task.page.sentry.Content.4f38f202dc", "Events")}</SelectItem>
            <SelectItem value="user">{translate("auto.components.task.page.sentry.Content.7299517360", "Users")}</SelectItem>
          </SelectContent>
        </Select>
        <form
          className="flex min-w-52 flex-1 gap-2"
          onSubmit={(event) => {
            event.preventDefault()
            void loadIssues()
          }}
        >
          <Input
            className="h-8"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={translate("auto.components.task.page.sentry.Content.b05286cc83", "Sentry search query")}
          />
          <Button type="submit" size="sm">
            {translate("auto.components.task.page.sentry.Content.25172c3f31", "Search")}</Button>
        </form>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={translate("auto.components.task.page.sentry.Content.f50a8e43b5", "Refresh Sentry issues")}
          onClick={() => void loadIssues()}
        >
          <RefreshCw className="size-4" />
        </Button>
      </div>
      {error ? (
        <div
          role="alert"
          className="border-b border-destructive/20 bg-destructive/10 px-3 py-2 text-sm text-destructive"
        >
          {error}
        </div>
      ) : null}
      <div className="scrollbar-sleek min-h-0 flex-1 overflow-auto">
        {loading && !issueRows.length ? (
          <div className="flex h-full items-center justify-center">
            <Loader2 className="size-6 animate-spin text-muted-foreground" />
          </div>
        ) : issueRows.length ? (
          <div className="divide-y divide-border/40">
            {issueRows.map((issue) => (
              <button
                key={issue.id}
                type="button"
                className="grid w-full grid-cols-[110px_minmax(220px,1fr)_130px_100px_100px] items-center gap-3 px-3 py-2.5 text-left text-sm hover:bg-muted/50"
                onClick={() => setSelectedIssue(issue)}
              >
                <span className="font-mono text-xs text-muted-foreground">{issue.shortId}</span>
                <span className="min-w-0">
                  <span className="block truncate font-medium">{issue.title}</span>
                  <span className="block truncate text-xs text-muted-foreground">
                    {issue.culprit}
                  </span>
                </span>
                <span className="truncate text-xs">{issue.project.name}</span>
                <span className="text-xs capitalize">{issue.priority ?? issue.level}</span>
                <span className="text-right text-xs text-muted-foreground">
                  {relativeTime(issue.lastSeen)}
                </span>
              </button>
            ))}
          </div>
        ) : (
          <div className="flex h-full min-h-52 items-center justify-center text-sm text-muted-foreground">
            {translate("auto.components.task.page.sentry.Content.ffe7c243dc", "No Sentry issues match these filters.")}</div>
        )}
      </div>
      <div className="flex items-center justify-between border-t border-border/50 p-2">
        <div className="flex gap-2">
          <Button
            variant="ghost"
            size="sm"
            disabled={!connection}
            onClick={() =>
              connection &&
              void window.api.shell.openUrl(
                `${connection.baseUrl}/organizations/${connection.organization.slug}/issues/`
              )
            }
          >
            <ExternalLink className="size-4" />
            {translate("auto.components.task.page.sentry.Content.7e214329ca", "Open Sentry")}</Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() =>
              void sentryTestConnection(settings)
                .then((result) =>
                  result.ok ? toast.success(translate("auto.components.task.page.sentry.Content.e51fc0fbd7", "Sentry connection works.")) : toast.error(result.error)
                )
                .catch((cause) =>
                  toast.error(
                    cause instanceof Error ? cause.message : translate("auto.components.task.page.sentry.Content.29e70b2996", "Could not test the Sentry connection.")
                  )
                )
            }
          >
            {translate("auto.components.task.page.sentry.Content.9063f9b03b", "Test connection")}</Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() =>
              void sentryDisconnect(settings)
                .then(() =>
                  setStatus({ connected: false, connection: null, organizations: [] })
                )
                .catch((cause) =>
                  toast.error(
                    cause instanceof Error ? cause.message : translate("auto.components.task.page.sentry.Content.b381f3e7a1", "Could not disconnect from Sentry.")
                  )
                )
            }
          >
            {translate("auto.components.task.page.sentry.Content.b0ac878654", "Disconnect")}</Button>
        </div>
        {page.nextCursor ? (
          <Button
            variant="outline"
            size="sm"
            disabled={loading}
            onClick={() => void loadIssues(page.nextCursor ?? undefined)}
          >
            {loading ? <Loader2 className="size-4 animate-spin" /> : null}{translate("auto.components.task.page.sentry.Content.e67bacb7cf", "Load more")}</Button>
        ) : null}
      </div>
      <SentryIssueDialog
        issue={selectedIssue}
        settings={settings}
        onClose={() => setSelectedIssue(null)}
        onChanged={updateIssue}
        onStartWork={startWork}
      />
      <SentryConnectDialog
        open={connectOpen}
        onOpenChange={setConnectOpen}
        settings={settings}
        onConnected={(next) => {
          setStatus(next)
          void loadProviderData(true).catch((cause) =>
            setError(
              cause instanceof Error
                ? cause.message
                : translate(
                    'auto.components.task.page.sentry.Content.catalogFailed',
                    'Could not load Sentry projects and environments.'
                  )
            )
          )
        }}
      />
    </div>
  )
}

function FilterMenu({
  label,
  items,
  selected,
  onChange
}: {
  label: string
  items: { id: string; label: string }[]
  selected: Set<string>
  onChange: (next: Set<string>) => void
}): React.JSX.Element {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="sm">
          {label}
          <ChevronDown className="size-3" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent className="scrollbar-sleek max-h-72 overflow-auto">
        {items.map((item) => (
          <DropdownMenuCheckboxItem
            key={item.id}
            checked={selected.has(item.id)}
            onCheckedChange={(checked) => {
              const next = new Set(selected)
              if (checked) {
                next.add(item.id)
              } else {
                next.delete(item.id)
              }
              onChange(next)
            }}
          >
            {item.label}
          </DropdownMenuCheckboxItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
