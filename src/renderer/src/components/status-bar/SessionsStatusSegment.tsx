import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { Terminal, Trash2 } from 'lucide-react'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { useAppStore } from '../../store'
import { activateAndRevealWorktree } from '@/lib/worktree-activation'

type DaemonSession = { id: string; cwd: string; title: string }

function shortCwd(cwd: string): string {
  if (!cwd) {
    return 'unknown'
  }
  const separator = cwd.includes('\\') ? '\\' : '/'
  const parts = cwd.split(/[\\/]+/).filter(Boolean)
  return parts.length > 2 ? parts.slice(-2).join(separator) : cwd
}

function sessionLabel(session: DaemonSession, tabTitle?: string): string {
  if (session.cwd) {
    return shortCwd(session.cwd)
  }
  // Why: daemon session IDs use the format `${worktreeId}@@${shortUuid}`.
  // When the shell hasn't emitted OSC 7 cwd updates (e.g. Claude Code agents),
  // fall back to showing the worktreeId portion so the user can identify which
  // worktree the session belongs to.
  const sep = session.id.lastIndexOf('@@')
  if (sep !== -1) {
    const worktreeId = session.id.slice(0, sep)
    return shortCwd(worktreeId)
  }
  // Why: for sessions with legacy numeric IDs (e.g. from LocalPtyProvider) or
  // sessions whose shells haven't emitted OSC 7, use the tab title from the
  // renderer store — it carries the live terminal title shown in the tab bar.
  // Fall back to the daemon-reported title (typically "shell") so orphan
  // sessions without a bound tab still display something meaningful.
  if (tabTitle) {
    return tabTitle
  }
  if (session.title) {
    return session.title
  }
  return 'unknown'
}

function SessionRow({
  session,
  isBound,
  tabId,
  tabTitle,
  onKill,
  onNavigate
}: {
  session: DaemonSession
  isBound: boolean
  tabId: string | null
  tabTitle: string | undefined
  onKill: (id: string) => void
  onNavigate: (tabId: string) => void
}): React.JSX.Element {
  return (
    <div
      className={`flex items-center gap-2 px-2 py-1.5 rounded ${
        tabId ? 'cursor-pointer hover:bg-accent/60' : ''
      }`}
      onClick={tabId ? () => onNavigate(tabId) : undefined}
    >
      <span
        className={`size-1.5 shrink-0 rounded-full ${isBound ? 'bg-emerald-500' : 'bg-muted-foreground/40'}`}
      />
      <div className="min-w-0 flex-1">
        <div className="truncate text-[12px] font-medium font-mono">
          {sessionLabel(session, tabTitle)}
        </div>
      </div>
      {!isBound && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation()
            onKill(session.id)
          }}
          className="shrink-0 rounded p-0.5 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
          aria-label={`Kill session ${session.id}`}
        >
          <Trash2 className="size-3" />
        </button>
      )}
    </div>
  )
}

export function SessionsStatusSegment({
  compact: _compact,
  iconOnly
}: {
  compact: boolean
  iconOnly: boolean
}): React.JSX.Element {
  const [sessions, setSessions] = useState<DaemonSession[]>([])
  const [open, setOpen] = useState(false)
  const tabsByWorktree = useAppStore((s) => s.tabsByWorktree)
  const ptyIdsByTabId = useAppStore((s) => s.ptyIdsByTabId)
  const runtimePaneTitlesByTabId = useAppStore((s) => s.runtimePaneTitlesByTabId)
  const workspaceSessionReady = useAppStore((s) => s.workspaceSessionReady)
  const setActiveTab = useAppStore((s) => s.setActiveTab)
  const setActiveView = useAppStore((s) => s.setActiveView)

  const boundPtyIds = useMemo(
    () => new Set(Object.values(ptyIdsByTabId).flat().filter(Boolean)),
    [ptyIdsByTabId]
  )

  // Why: ptyIdsByTabId tracks all ptyIds a tab has ever been associated with
  // (including split panes). Build a reverse map so we can navigate from a
  // daemon session ID back to the tab that owns it.
  const ptyIdToTabId = useMemo(() => {
    const map = new Map<string, string>()
    for (const [tabId, ptyIds] of Object.entries(ptyIdsByTabId)) {
      for (const ptyId of ptyIds) {
        map.set(ptyId, tabId)
      }
    }
    return map
  }, [ptyIdsByTabId])

  const tabIdToWorktreeId = useMemo(() => {
    const map = new Map<string, string>()
    for (const [worktreeId, tabs] of Object.entries(tabsByWorktree)) {
      for (const tab of tabs) {
        map.set(tab.id, worktreeId)
      }
    }
    return map
  }, [tabsByWorktree])

  // Why: the daemon IPC response has sparse metadata (cwd may be null, title is
  // hardcoded to "shell"), but the renderer store already knows each tab's live
  // title. Build a ptyId→title map so the popover can show the same name as the
  // tab bar for bound sessions.
  const ptyIdToTabTitle = useMemo(() => {
    // Why: build a tabId→tab lookup once up-front instead of doing
    // O(totalTabs) .flat().find() per ptyIdsByTabId entry.
    const tabById = new Map<string, (typeof tabsByWorktree)[string][number]>()
    for (const tabs of Object.values(tabsByWorktree)) {
      for (const tab of tabs) {
        tabById.set(tab.id, tab)
      }
    }
    const map = new Map<string, string>()
    for (const [tabId, ptyIds] of Object.entries(ptyIdsByTabId)) {
      const tab = tabById.get(tabId)
      if (!tab) {
        continue
      }
      // Why: runtimePaneTitlesByTabId holds the most current OSC-reported title
      // for each mounted pane — it updates on every title change regardless of
      // which split pane is focused. Prefer the first non-empty runtime pane
      // title, then the persisted tab.title (which only updates for the focused
      // pane), then the stable defaultTitle.
      const runtimeTitles = runtimePaneTitlesByTabId[tabId]
      const liveTitle = runtimeTitles
        ? Object.values(runtimeTitles).find((t) => t?.trim())
        : undefined
      const title =
        tab.customTitle?.trim() || liveTitle?.trim() || tab.title || tab.defaultTitle?.trim()
      if (title) {
        for (const ptyId of ptyIds) {
          map.set(ptyId, title)
        }
      }
    }
    return map
  }, [ptyIdsByTabId, tabsByWorktree, runtimePaneTitlesByTabId])

  const refresh = useCallback(async () => {
    try {
      const result = await window.api.pty.listSessions()
      setSessions(result)
    } catch {
      setSessions([])
    }
  }, [])

  useEffect(() => {
    if (open) {
      void refresh()
    }
  }, [open, refresh])

  useEffect(() => {
    const interval = setInterval(() => void refresh(), 10_000)
    void refresh()
    return () => clearInterval(interval)
  }, [refresh])

  const orphanCount = workspaceSessionReady
    ? sessions.filter((s) => !boundPtyIds.has(s.id)).length
    : 0

  const handleKill = useCallback(
    async (id: string) => {
      try {
        await window.api.pty.kill(id)
      } catch {
        /* already dead */
      }
      await refresh()
    },
    [refresh]
  )

  const handleKillOrphans = useCallback(async () => {
    if (!workspaceSessionReady) {
      return
    }
    const orphans = sessions.filter((s) => !boundPtyIds.has(s.id))
    await Promise.allSettled(orphans.map((s) => window.api.pty.kill(s.id)))
    await refresh()
  }, [sessions, boundPtyIds, refresh, workspaceSessionReady])

  const handleNavigate = useCallback(
    (tabId: string) => {
      const worktreeId = tabIdToWorktreeId.get(tabId)
      if (worktreeId) {
        // Why: opening a session from the status bar is another worktree jump,
        // so route it through the shared activation path before restoring the
        // specific tab inside that worktree.
        activateAndRevealWorktree(worktreeId)
      }
      setActiveView('terminal')
      setActiveTab(tabId)
    },
    [tabIdToWorktreeId, setActiveView, setActiveTab]
  )

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className="inline-flex items-center gap-1.5 cursor-pointer rounded px-1 py-0.5 hover:bg-accent/70"
          aria-label="Terminal sessions"
        >
          <Terminal className="size-3 text-muted-foreground" />
          {!iconOnly && (
            <span className="text-[11px] tabular-nums">
              {sessions.length}
              {orphanCount > 0 && <span className="text-yellow-500 ml-0.5">({orphanCount})</span>}
            </span>
          )}
          {iconOnly && sessions.length > 0 && (
            <span className="text-[11px] tabular-nums">{sessions.length}</span>
          )}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent side="top" align="end" sideOffset={8} className="w-[260px]">
        <div className="px-2 pt-1.5 pb-1 text-[10px] font-medium uppercase tracking-[0.08em] text-muted-foreground">
          Terminal Sessions ({sessions.length})
        </div>
        {sessions.length === 0 ? (
          <div className="px-2 py-3 text-center text-[11px] text-muted-foreground">
            No active sessions
          </div>
        ) : (
          <div className="max-h-[240px] overflow-y-auto scrollbar-sleek">
            {[...sessions]
              .sort((a, b) => {
                const aBound = workspaceSessionReady && boundPtyIds.has(a.id) ? 0 : 1
                const bBound = workspaceSessionReady && boundPtyIds.has(b.id) ? 0 : 1
                return aBound - bBound
              })
              .map((s) => {
                const tabId = ptyIdToTabId.get(s.id) ?? null
                return (
                  <SessionRow
                    key={s.id}
                    session={s}
                    isBound={workspaceSessionReady && boundPtyIds.has(s.id)}
                    tabId={tabId}
                    tabTitle={ptyIdToTabTitle.get(s.id)}
                    onKill={handleKill}
                    onNavigate={handleNavigate}
                  />
                )
              })}
          </div>
        )}
        {orphanCount > 0 && (
          <>
            <DropdownMenuSeparator />
            <div className="px-2 py-2">
              <button
                type="button"
                onClick={() => void handleKillOrphans()}
                className="inline-flex w-full items-center justify-center rounded-md border border-border/70 px-2.5 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-accent/60"
              >
                Kill {orphanCount} Orphan{orphanCount > 1 ? 's' : ''}
              </button>
            </div>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
