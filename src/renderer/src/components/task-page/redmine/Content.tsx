import { useEffect, useState } from 'react'
import { useAppStore } from '@/store'
import { translate } from '@/i18n/i18n'
import { RedmineIcon } from '@/components/icons/RedmineIcon'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import type { TaskPageComposerActionsModel } from '../../use-task-page-composer-actions'
import type { RedmineIssue } from '../../../../../shared/redmine-types'

function statusTone(statusName?: string | null): string {
  switch ((statusName ?? '').toLowerCase()) {
    case 'new':
    case 'open':
      return 'bg-amber-500/15 text-amber-700 dark:text-amber-300'
    case 'in progress':
    case 'in_progress':
      return 'bg-blue-500/15 text-blue-700 dark:text-blue-300'
    case 'closed':
    case 'resolved':
      return 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300'
    default:
      return 'bg-muted text-muted-foreground'
  }
}

function ConnectPrompt() {
  const connectRedmine = useAppStore((s) => s.connectRedmine)
  const [siteUrl, setSiteUrl] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleConnect() {
    setBusy(true)
    setError(null)
    const result = await connectRedmine({ siteUrl: siteUrl.trim(), apiKey: apiKey.trim() })
    setBusy(false)
    if (!result.ok) {
      setError(result.error.message)
    }
  }

  return (
    <div className="mt-4 flex flex-col items-center justify-center rounded-md border border-border/50 bg-muted/50 px-6 py-10 text-center shadow-sm">
      <RedmineIcon className="mb-4 size-8 text-muted-foreground/60" />
      <p className="text-base font-medium text-foreground">
        {translate('auto.components.TaskPage.redmineConnectTitle', 'Connect your Redmine server')}
      </p>
      <p className="mt-2 max-w-sm text-sm text-muted-foreground">
        {translate(
          'auto.components.TaskPage.redmineConnectBody',
          'Add a self-hosted Redmine server URL and an API key to browse your assigned issues.'
        )}
      </p>
      <form
        className="mt-5 flex w-full max-w-sm flex-col gap-3 text-left"
        onSubmit={(e) => {
          e.preventDefault()
          void handleConnect()
        }}
      >
        <Label htmlFor="redmine-site-url">
          {translate('auto.components.TaskPage.redmineSiteUrl', 'Server URL')}
        </Label>
        <Input
          id="redmine-site-url"
          value={siteUrl}
          onChange={(e) => setSiteUrl(e.target.value)}
          placeholder="https://redmine.example.com"
          autoComplete="off"
        />
        <Label htmlFor="redmine-api-key">
          {translate('auto.components.TaskPage.redmineApiKey', 'API key')}
        </Label>
        <Input
          id="redmine-api-key"
          type="password"
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
          autoComplete="off"
        />
        {error ? <p className="text-sm text-destructive">{error}</p> : null}
        <div className="mt-1 flex flex-wrap items-center gap-2">
          <Button type="submit" disabled={busy}>
            {busy
              ? translate('auto.components.TaskPage.redmineConnecting', 'Connecting…')
              : translate('auto.components.TaskPage.redmineConnect', 'Connect Redmine')}
          </Button>
        </div>
      </form>
    </div>
  )
}

export function TaskPageRedmineContent({
  model
}: {
  model: TaskPageComposerActionsModel
}): React.JSX.Element | null {
  const redmineStatus = useAppStore((s) => s.redmineStatus)
  const checkRedmineConnection = useAppStore((s) => s.checkRedmineConnection)
  const listRedmineIssues = useAppStore((s) => s.listRedmineIssues)
  const getRedmineIssue = useAppStore((s) => s.getRedmineIssue)

  const [issues, setIssues] = useState<RedmineIssue[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [selected, setSelected] = useState<RedmineIssue | null>(null)
  const { taskSource } = model

  const connected = redmineStatus.connected

  useEffect(() => {
    void checkRedmineConnection()
    // Why: probe once on mount; deeper refreshes happen after connect/list.
  }, [checkRedmineConnection])

  useEffect(() => {
    if (!connected) {
      // Why: drop stale list/detail/error so a reconnect to a different site
      // never shows the previous site's issues.
      setIssues([])
      setSelected(null)
      setError(null)
      setLoading(false)
      return
    }
    let cancelled = false
    setLoading(true)
    setError(null)
    void listRedmineIssues({ scope: 'assigned' })
      .then((result) => {
        if (cancelled) {
          return
        }
        setIssues(result?.items ?? [])
        setError(result?.error?.message ?? null)
        setLoading(false)
      })
      .catch(() => {
        if (cancelled) {
          return
        }
        setError('Failed to load issues.')
        setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [connected, listRedmineIssues])

  function openIssue(issue: RedmineIssue) {
    setSelected(issue)
    void getRedmineIssue(issue.id).then(({ issue: full }) => {
      if (full) {
        setSelected(full)
      }
    })
  }

  return taskSource === 'redmine' ? (
    !connected ? (
      <ConnectPrompt />
    ) : (
      <div className="flex min-h-0 max-h-full flex-col overflow-hidden rounded-md rounded-t-none border border-t-0 border-border/50 bg-background shadow-sm">
        <div className="flex h-10 flex-none items-center justify-between gap-3 border-b border-border/50 bg-muted/35 px-3">
          <div className="min-w-0 text-[11px] font-medium uppercase tracking-[0.12em] text-muted-foreground">
            {translate('auto.components.TaskPage.redmineTitle', 'Redmine issues')}
          </div>
          <div className="shrink-0 text-[11px] text-muted-foreground">
            {issues.length} {translate('auto.components.TaskPage.b7bae28b6a', 'shown')}
          </div>
        </div>

        {selected ? (
          <div className="min-h-0 flex-1 overflow-y-auto scrollbar-sleek">
            <div className="border-b border-border/50 px-4 py-3">
              <Button
                variant="ghost"
                className="mb-2 px-2 text-xs"
                onClick={() => setSelected(null)}
              >
                ← {translate('auto.components.TaskPage.redmineBackToList', 'Back to list')}
              </Button>
              <div className="text-sm text-muted-foreground">
                {selected.tracker?.name ?? 'Issue'} #{selected.id}
              </div>
              <div className="mt-1 text-base font-medium text-foreground">{selected.subject}</div>
              <div className="mt-2 text-xs text-muted-foreground">
                {selected.project?.name}
                {selected.assignedTo || selected.priority
                  ? ` · ${selected.assignedTo?.name ?? ''}${
                      selected.priority?.name ? ` · ${selected.priority.name}` : ''
                    }`
                  : ''}
              </div>
            </div>
            <dl className="divide-y divide-border/50 text-sm">
              <Row label="Status" value={selected.status?.name} />
              <Row label="Priority" value={selected.priority?.name} />
              <Row label="Tracker" value={selected.tracker?.name} />
              <Row label="Assignee" value={selected.assignedTo?.name} />
              <Row label="Progress" value={`${selected.doneRatio ?? 0}%`} />
              <Row label="Created" value={selected.createdOn} />
              <Row label="Updated" value={selected.updatedOn} />
              {selected.customFields?.length ? (
                selected.customFields.map((field, i) => (
                  <Row
                    key={i}
                    label={field.name}
                    value={field.value ? String(field.value) : undefined}
                  />
                ))
              ) : (
                <Row label="Custom fields" value="—" />
              )}
              {selected.description ? (
                <div className="whitespace-pre-wrap px-4 py-3 text-sm text-foreground">
                  {selected.description}
                </div>
              ) : null}
            </dl>
          </div>
        ) : (
          <div
            className="min-h-0 flex-1 overflow-y-auto scrollbar-sleek"
            style={{ scrollbarGutter: 'stable' }}
          >
            {error ? (
              <div className="border-b border-border px-4 py-4 text-sm text-destructive">
                {error}
              </div>
            ) : null}

            {loading ? (
              <div className="divide-y divide-border/50">
                {Array.from({ length: 6 }).map((_, i) => (
                  <div key={i} className="px-3 py-3">
                    <div className="h-4 w-4/5 animate-pulse rounded bg-muted/70" />
                    <div className="mt-2 h-3 w-3/5 animate-pulse rounded bg-muted/60" />
                  </div>
                ))}
              </div>
            ) : null}

            {!loading && issues.length === 0 && !error ? (
              <div className="px-4 py-10 text-center">
                <p className="text-sm font-medium text-foreground">
                  {translate('auto.components.TaskPage.redmineNoIssues', 'No Redmine issues found')}
                </p>
              </div>
            ) : null}

            {!loading ? (
              <div className="divide-y divide-border/50">
                {issues.map((issue) => (
                  <button
                    key={issue.id}
                    type="button"
                    onClick={() => openIssue(issue)}
                    className="flex w-full items-center gap-3 px-3 py-2.5 text-left hover:bg-muted/40 focus:outline-none"
                  >
                    <span className="shrink-0 font-mono text-xs text-muted-foreground">
                      {issue.tracker ? `${issue.tracker.name} ` : ''}#{issue.id}
                    </span>
                    <span className="min-w-0 flex-1 truncate text-sm text-foreground">
                      {issue.subject}
                    </span>
                    <span
                      className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] ${statusTone(
                        issue.status?.name
                      )}`}
                    >
                      {issue.status?.name ?? '—'}
                    </span>
                  </button>
                ))}
              </div>
            ) : null}
          </div>
        )}
      </div>
    )
  ) : null

  function Row({ label, value }: { label: string; value?: string | null }) {
    return (
      <div className="flex items-start justify-between gap-4 px-4 py-2">
        <dt className="text-muted-foreground">{label}</dt>
        <dd className="text-right text-foreground">{value || '—'}</dd>
      </div>
    )
  }
}
