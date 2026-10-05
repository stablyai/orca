import { useEffect, useState } from 'react'
import { LoaderCircle, LogOut, Plus, RefreshCw } from 'lucide-react'
import { YouTrackIcon } from '@/components/icons/YouTrackIcon'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { translate } from '@/i18n/i18n'
import { cn } from '@/lib/utils'
import type { YouTrackIssuePreset } from '../../../../shared/youtrack-types'
import { YouTrackConnectDialog } from './YouTrackConnectDialog'
import { YouTrackCreateIssueDialog } from './YouTrackCreateIssueDialog'
import { YouTrackIssueList } from './YouTrackIssueList'
import { YouTrackIssueSheet } from './YouTrackIssueSheet'
import { startYouTrackIssueWorkspace } from './youtrack-workspace'
import { useYouTrackStore } from './youtrack-store'

function getPresets(): { id: YouTrackIssuePreset; label: string }[] {
  return [
    { id: 'assigned', label: translate('youtrack.preset.assigned', 'Assigned to me') },
    { id: 'reported', label: translate('youtrack.preset.reported', 'Reported') },
    { id: 'open', label: translate('youtrack.preset.open', 'All open') },
    { id: 'done', label: translate('youtrack.preset.done', 'Done') }
  ]
}

function YouTrackToolbar(): React.JSX.Element {
  const preset = useYouTrackStore((s) => s.preset)
  const query = useYouTrackStore((s) => s.query)
  const loading = useYouTrackStore((s) => s.issuesLoading)
  const status = useYouTrackStore((s) => s.status)
  const setPreset = useYouTrackStore((s) => s.setPreset)
  const setQuery = useYouTrackStore((s) => s.setQuery)
  const loadIssues = useYouTrackStore((s) => s.loadIssues)
  const disconnect = useYouTrackStore((s) => s.disconnect)
  const addIssue = useYouTrackStore((s) => s.addIssue)
  const selectIssue = useYouTrackStore((s) => s.selectIssue)
  const [queryDraft, setQueryDraft] = useState(query)
  const [createOpen, setCreateOpen] = useState(false)

  useEffect(() => {
    setQueryDraft(query)
  }, [query])

  return (
    <div className="flex flex-wrap items-center gap-2 border-b border-border/50 bg-muted/35 px-3 py-2">
      <div className="flex items-center gap-1">
        {getPresets().map((entry) => (
          <Button
            key={entry.id}
            type="button"
            size="xs"
            variant={!query && preset === entry.id ? 'secondary' : 'ghost'}
            onClick={() => setPreset(entry.id)}
            aria-pressed={!query && preset === entry.id}
          >
            {entry.label}
          </Button>
        ))}
      </div>
      <form
        className="min-w-[200px] flex-1"
        onSubmit={(event) => {
          event.preventDefault()
          setQuery(queryDraft)
        }}
      >
        <Input
          value={queryDraft}
          onChange={(event) => setQueryDraft(event.target.value)}
          placeholder={translate(
            'youtrack.toolbar.queryPlaceholder',
            'YouTrack query, e.g. Assignee: me #Unresolved project: ABC — Enter to search'
          )}
        />
      </form>
      <Button type="button" size="sm" onClick={() => setCreateOpen(true)}>
        <Plus className="size-3.5" />
        {translate('youtrack.toolbar.newIssue', 'New issue')}
      </Button>
      <YouTrackCreateIssueDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        onCreated={(issue) => {
          addIssue(issue)
          selectIssue(issue.idReadable)
        }}
      />
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        onClick={() => void loadIssues({ force: true })}
        disabled={loading}
        aria-label={translate('youtrack.toolbar.refresh', 'Refresh')}
      >
        <RefreshCw className={cn('size-3.5', loading && 'animate-spin')} />
      </Button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button type="button" variant="ghost" size="xs">
            <span className="truncate">{status.viewer?.fullName ?? status.viewer?.login}</span>
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuLabel>{status.baseUrl}</DropdownMenuLabel>
          {status.allowInsecureTls ? (
            <DropdownMenuLabel>
              {translate('youtrack.toolbar.insecureTls', 'Certificate verification skipped')}
            </DropdownMenuLabel>
          ) : null}
          <DropdownMenuSeparator />
          <DropdownMenuItem
            onSelect={() => {
              if (status.baseUrl) {
                void window.api.shell.openUrl(status.baseUrl)
              }
            }}
          >
            <YouTrackIcon className="size-3.5" />
            {translate('youtrack.toolbar.openYouTrack', 'Open YouTrack')}
          </DropdownMenuItem>
          <DropdownMenuItem variant="destructive" onSelect={() => void disconnect()}>
            <LogOut className="size-3.5" />
            {translate('youtrack.toolbar.disconnect', 'Disconnect')}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}

export function YouTrackTaskContent({ onHide }: { onHide: () => void }): React.JSX.Element {
  const status = useYouTrackStore((s) => s.status)
  const statusChecked = useYouTrackStore((s) => s.statusChecked)
  const checkStatus = useYouTrackStore((s) => s.checkStatus)
  const issues = useYouTrackStore((s) => s.issues)
  const issuesLoading = useYouTrackStore((s) => s.issuesLoading)
  const issuesError = useYouTrackStore((s) => s.issuesError)
  const preset = useYouTrackStore((s) => s.preset)
  const query = useYouTrackStore((s) => s.query)
  const loadIssues = useYouTrackStore((s) => s.loadIssues)
  const selectedIssueId = useYouTrackStore((s) => s.selectedIssueId)
  const selectIssue = useYouTrackStore((s) => s.selectIssue)
  const [connectOpen, setConnectOpen] = useState(false)

  useEffect(() => {
    void checkStatus()
  }, [checkStatus])

  // Why: the selection lives in a module store; without this the sheet reopens on every return to Tasks.
  useEffect(() => () => selectIssue(null), [selectIssue])

  useEffect(() => {
    if (status.connected) {
      void loadIssues()
    }
  }, [status.connected, preset, query, loadIssues])

  if (!statusChecked) {
    return (
      <div className="mt-4 flex items-center justify-center py-14">
        <LoaderCircle className="size-5 animate-spin text-muted-foreground" />
      </div>
    )
  }

  if (!status.connected) {
    return (
      <div className="mt-4 flex flex-col items-center justify-center rounded-md border border-border/50 bg-muted/50 px-6 py-14 text-center shadow-sm">
        <YouTrackIcon className="mb-4 size-8 text-muted-foreground/60" />
        <p className="text-base font-medium text-foreground">
          {translate('youtrack.empty.title', 'Connect your YouTrack')}
        </p>
        <p className="mt-2 max-w-sm text-sm text-muted-foreground">
          {status.credentialError ??
            translate(
              'youtrack.empty.description',
              'Browse your issues, move them between states, comment, and start work directly from here.'
            )}
        </p>
        <div className="mt-5 flex flex-wrap items-center justify-center gap-2">
          <Button onClick={() => setConnectOpen(true)}>
            {translate('youtrack.empty.connect', 'Connect YouTrack')}
          </Button>
          <Button variant="outline" onClick={onHide}>
            {translate('youtrack.empty.hide', 'Hide YouTrack')}
          </Button>
        </div>
        <YouTrackConnectDialog open={connectOpen} onOpenChange={setConnectOpen} />
      </div>
    )
  }

  return (
    <div className="mt-3 flex min-h-0 max-h-full flex-col overflow-hidden rounded-md border border-border/50 bg-background shadow-sm">
      <YouTrackToolbar />
      <div
        className="min-h-0 flex-1 overflow-y-auto scrollbar-sleek"
        style={{ scrollbarGutter: 'stable' }}
      >
        {issuesError ? (
          <div className="border-b border-border px-4 py-3 text-sm text-destructive">
            {issuesError}
          </div>
        ) : null}
        {issuesLoading && issues.length === 0 ? (
          <div className="divide-y divide-border/50">
            {Array.from({ length: 6 }).map((_, index) => (
              <div key={index} className="px-3 py-3">
                <div className="h-4 w-4/5 animate-pulse rounded bg-muted/70" />
                <div className="mt-2 h-3 w-3/5 animate-pulse rounded bg-muted/60" />
              </div>
            ))}
          </div>
        ) : null}
        {!issuesLoading && issues.length === 0 && !issuesError ? (
          <div className="px-4 py-10 text-center">
            <p className="text-sm font-medium text-foreground">
              {translate('youtrack.list.emptyTitle', 'No YouTrack issues found')}
            </p>
            <p className="mt-2 text-sm text-muted-foreground">
              {query
                ? translate('youtrack.list.emptyQuery', 'Try a different query.')
                : translate('youtrack.list.emptyPreset', 'No issues match the selected filter.')}
            </p>
          </div>
        ) : null}
        <YouTrackIssueList
          issues={issues}
          selectedIssueId={selectedIssueId}
          onOpenIssue={(issue) => selectIssue(issue.idReadable)}
          onStartWorkspace={startYouTrackIssueWorkspace}
        />
      </div>
      <YouTrackIssueSheet issueId={selectedIssueId} onClose={() => selectIssue(null)} />
    </div>
  )
}
