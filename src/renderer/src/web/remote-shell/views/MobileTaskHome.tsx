import { useMemo, useState } from 'react'
import {
  ChevronRight,
  CircleAlert,
  FolderGit2,
  Loader2,
  RefreshCw,
  Search,
  Wifi,
  WifiOff
} from 'lucide-react'
import { cn } from '@/lib/utils'
import {
  formatMobileRelativeTime,
  mobileAgentLabel,
  type MobileSessionCard,
  type MobileWorkspaceGroup
} from '../mobile-remote-model'

export type MobileConnectionState = 'connecting' | 'connected' | 'offline'

export type MobileTaskHomeProps = {
  hostName: string
  connectionState: MobileConnectionState
  workspaces: readonly MobileWorkspaceGroup[]
  loading: boolean
  error: string | null
  onRefresh: () => void
  onSelectSession: (sessionId: string) => void
}

function statusChip(session: MobileSessionCard): React.JSX.Element {
  if (session.status === 'attention') {
    return (
      <span className="inline-flex items-center gap-1 rounded-full border border-amber-500/40 bg-amber-500/15 px-2 py-0.5 text-[10px] font-semibold text-amber-700 dark:text-amber-300">
        <CircleAlert size={10} aria-hidden />
        Needs you
      </span>
    )
  }
  if (session.status === 'working') {
    return (
      <span className="inline-flex items-center gap-1 rounded-full border border-sky-500/40 bg-sky-500/15 px-2 py-0.5 text-[10px] font-semibold text-sky-700 dark:text-sky-300">
        <span className="size-1.5 animate-pulse rounded-full bg-sky-500" aria-hidden />
        Working
      </span>
    )
  }
  return (
    <span className="inline-flex items-center rounded-full border border-border bg-muted px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
      Idle
    </span>
  )
}

function filterWorkspaces(
  workspaces: readonly MobileWorkspaceGroup[],
  query: string
): MobileWorkspaceGroup[] {
  const needle = query.trim().toLowerCase()
  if (!needle) {
    return [...workspaces]
  }
  return workspaces
    .map((workspace) => {
      const workspaceMatches =
        workspace.name.toLowerCase().includes(needle) ||
        workspace.branch.toLowerCase().includes(needle) ||
        workspace.path.toLowerCase().includes(needle)
      const sessions = workspaceMatches
        ? workspace.sessions
        : workspace.sessions.filter(
            (session) =>
              session.title.toLowerCase().includes(needle) ||
              session.preview.toLowerCase().includes(needle) ||
              mobileAgentLabel(session.agent).toLowerCase().includes(needle)
          )
      return { ...workspace, sessions }
    })
    .filter((workspace) => workspace.sessions.length > 0)
}

export function MobileTaskHome({
  hostName,
  connectionState,
  workspaces,
  loading,
  error,
  onRefresh,
  onSelectSession
}: MobileTaskHomeProps): React.JSX.Element {
  const [query, setQuery] = useState('')
  const visibleWorkspaces = useMemo(() => filterWorkspaces(workspaces, query), [workspaces, query])
  const totals = useMemo(() => {
    let working = 0
    let attention = 0
    for (const workspace of workspaces) {
      for (const session of workspace.sessions) {
        if (session.status === 'working') {
          working += 1
        } else if (session.status === 'attention') {
          attention += 1
        }
      }
    }
    return { working, attention }
  }, [workspaces])
  const hasSessions = workspaces.some((workspace) => workspace.sessions.length > 0)

  return (
    <div className="min-h-dvh bg-background text-foreground">
      <header className="sticky top-0 z-10 border-b border-border/70 bg-background/95 backdrop-blur">
        <div className="flex items-center justify-between gap-3 px-4 pb-2 pt-[max(0.75rem,env(safe-area-inset-top))]">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="text-base font-bold tracking-tight">Orca</span>
              <span className="truncate text-xs text-muted-foreground">{hostName}</span>
            </div>
            <div className="mt-0.5 flex items-center gap-1.5 text-[11px] text-muted-foreground">
              {connectionState === 'connected' ? (
                <Wifi size={11} className="text-emerald-500" aria-hidden />
              ) : connectionState === 'connecting' ? (
                <Loader2 size={11} className="animate-spin" aria-hidden />
              ) : (
                <WifiOff size={11} className="text-destructive" aria-hidden />
              )}
              <span>
                {connectionState === 'connected'
                  ? `${totals.working} working · ${totals.attention} waiting`
                  : connectionState === 'connecting'
                    ? 'Connecting to desktop…'
                    : 'Desktop unreachable'}
              </span>
            </div>
          </div>
          <button
            type="button"
            onClick={onRefresh}
            aria-label="Refresh tasks"
            className="flex size-9 shrink-0 items-center justify-center rounded-full border border-border bg-muted/50 text-muted-foreground active:scale-95"
          >
            {loading ? (
              <Loader2 size={16} className="animate-spin" aria-hidden />
            ) : (
              <RefreshCw size={16} aria-hidden />
            )}
          </button>
        </div>
        <div className="px-4 pb-3">
          <label className="flex items-center gap-2 rounded-xl border border-border bg-muted/40 px-3 py-2">
            <Search size={15} className="shrink-0 text-muted-foreground" aria-hidden />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Filter projects or tasks"
              autoComplete="off"
              className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground/70"
            />
          </label>
        </div>
      </header>

      <main className="space-y-4 px-3 pb-[max(1.5rem,env(safe-area-inset-bottom))] pt-3">
        {error ? (
          <div className="rounded-xl border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {error}
          </div>
        ) : null}

        {loading && workspaces.length === 0 ? (
          <div className="flex items-center justify-center gap-2 py-16 text-sm text-muted-foreground">
            <Loader2 size={16} className="animate-spin" aria-hidden />
            Loading workspaces…
          </div>
        ) : null}

        {!loading && !hasSessions && !error ? (
          <div className="rounded-xl border border-border bg-muted/30 px-4 py-10 text-center">
            <p className="text-sm font-medium">No active agent tasks</p>
            <p className="mt-1 text-xs text-muted-foreground">
              Start a chat on the desktop and it will appear here.
            </p>
          </div>
        ) : null}

        {visibleWorkspaces.map((workspace) => (
          <section
            key={workspace.workspaceId}
            className="overflow-hidden rounded-xl border border-border/70 bg-card"
          >
            <div className="flex items-start gap-2 border-b border-border/60 px-3 py-2.5">
              <FolderGit2 size={15} className="mt-0.5 shrink-0 text-muted-foreground" aria-hidden />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5">
                  <h2 className="truncate text-sm font-semibold">{workspace.name}</h2>
                  {workspace.isActive ? (
                    <span className="shrink-0 rounded-full bg-primary/15 px-1.5 py-0.5 text-[9px] font-semibold text-primary">
                      FOCUSED
                    </span>
                  ) : null}
                </div>
                <p className="truncate font-mono text-[10px] text-muted-foreground">
                  {workspace.branch ? `⎇ ${workspace.branch}` : workspace.path}
                </p>
              </div>
            </div>

            {workspace.sessions.length === 0 ? (
              <p className="px-3 py-3 text-xs text-muted-foreground">No active tasks</p>
            ) : (
              <div className="divide-y divide-border/50">
                {workspace.sessions.map((session) => (
                  <button
                    key={session.sessionId}
                    type="button"
                    onClick={() => onSelectSession(session.sessionId)}
                    className="flex w-full items-start gap-3 px-3 py-3 text-left active:bg-muted/60"
                  >
                    <span
                      className={cn(
                        'mt-1 size-2 shrink-0 rounded-full',
                        session.status === 'attention'
                          ? 'bg-amber-500'
                          : session.status === 'working'
                            ? 'animate-pulse bg-sky-500'
                            : 'bg-muted-foreground/35'
                      )}
                      aria-hidden
                    />
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-2">
                        <span className="truncate text-sm font-medium">{session.title}</span>
                        {statusChip(session)}
                      </span>
                      {session.preview && session.preview !== session.title ? (
                        <span className="mt-0.5 line-clamp-2 block text-xs leading-4 text-muted-foreground">
                          {session.preview}
                        </span>
                      ) : null}
                      <span className="mt-1 flex items-center gap-2 text-[10px] text-muted-foreground">
                        <span className="rounded bg-muted px-1 py-0.5 font-semibold uppercase">
                          {mobileAgentLabel(session.agent)}
                        </span>
                        {session.toolName ? (
                          <span className="truncate font-mono">{session.toolName}</span>
                        ) : null}
                        <span className="ml-auto shrink-0">
                          {formatMobileRelativeTime(session.updatedAt)}
                        </span>
                      </span>
                    </span>
                    <ChevronRight
                      size={15}
                      className="mt-1 shrink-0 text-muted-foreground/60"
                      aria-hidden
                    />
                  </button>
                ))}
              </div>
            )}
          </section>
        ))}

        {query.trim() && visibleWorkspaces.length === 0 ? (
          <p className="py-10 text-center text-sm text-muted-foreground">
            No tasks match “{query.trim()}”.
          </p>
        ) : null}
      </main>
    </div>
  )
}
