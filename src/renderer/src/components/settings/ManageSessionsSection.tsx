/* eslint-disable max-lines -- Why: this pane owns all admin controls for the
   pty daemon (list, kill-all, kill-one, restart) plus the confirmation
   dialog and table. Splitting would scatter the shared action state and
   toast copy across files without a cleaner ownership seam. */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { LoaderCircle, RefreshCw, RotateCw, Trash2, X } from 'lucide-react'
import { toast } from 'sonner'
import type { PtyManagementSession } from '../../../../preload/api-types'
import { Button } from '../ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '../ui/dialog'
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip'
import { SearchableSetting } from './SearchableSetting'
import { useAppStore } from '../../store'
import { activateAndRevealWorktree } from '@/lib/worktree-activation'
import { useDaemonActions, DaemonActionDialog } from '../shared/useDaemonActions'

type ConfirmKind = 'killOne'

type PendingConfirm = { kind: 'killOne'; session: PtyManagementSession } | null

// Why: mirror the status-bar SessionsStatusSegment label style — last two
// path segments joined by the platform separator, no ellipsis prefix. This
// keeps the Manage Sessions table visually consistent with how Orca labels
// the same worktrees in the bottom status bar ("orca/Anemone").
function shortCwd(cwd: string): string {
  if (!cwd) {
    return 'unknown'
  }
  const separator = cwd.includes('\\') ? '\\' : '/'
  const parts = cwd.split(/[\\/]+/).filter(Boolean)
  return parts.length > 2 ? parts.slice(-2).join(separator) : cwd
}

function formatWorkspace(session: { cwd: string | null; sessionId: string }): string {
  if (session.cwd) {
    return shortCwd(session.cwd)
  }
  // Why: the daemon doesn't always populate `cwd` on listSessions (legacy
  // revived sessions, older protocol versions). Orca's session IDs embed
  // the workspace as `<worktreeId>@@<hash>` where worktreeId is usually
  // the absolute path. Fall back to parsing the id so we don't show "—"
  // when the info is right there. Matches SessionsStatusSegment's fallback.
  const sep = session.sessionId.lastIndexOf('@@')
  if (sep !== -1) {
    const worktreeId = session.sessionId.slice(0, sep)
    // Strip a leading `<uuid>::` prefix if present (newer protocol).
    const afterColons = worktreeId.split('::')
    const path = afterColons.at(-1)
    return shortCwd(path ?? worktreeId)
  }
  return 'unknown'
}

function formatState(session: PtyManagementSession): string {
  if (!session.isAlive) {
    return 'exited'
  }
  if (session.shellState === 'ready') {
    return 'running'
  }
  if (session.shellState === 'pending') {
    return 'starting'
  }
  return session.state
}

function getConfirmCopy(confirm: PendingConfirm): {
  title: string
  description: React.ReactNode
  confirmLabel: string
  busyLabel: string
} | null {
  if (!confirm) {
    return null
  }
  return {
    title: 'Kill this session?',
    description: (
      <>
        Force-quits <span className="font-medium text-foreground">{confirm.session.sessionId}</span>
        . Any unsaved work in that pane is lost. This can&apos;t be undone.
      </>
    ),
    confirmLabel: 'Kill session',
    busyLabel: 'Killing…'
  }
}

export function ManageSessionsSection(): React.JSX.Element {
  const [sessions, setSessions] = useState<PtyManagementSession[]>([])
  const [isRefreshing, setIsRefreshing] = useState(true)
  const [hasLoadedOnce, setHasLoadedOnce] = useState(false)
  const [confirm, setConfirm] = useState<PendingConfirm>(null)
  const [busyKind, setBusyKind] = useState<ConfirmKind | null>(null)
  // Why: optimistic UI snapshot for Kill-all rollback. The design doc calls
  // for emptying the list immediately and restoring it on error so users see
  // feedback without waiting for the retry loop to settle.
  const optimisticRollback = useRef<PtyManagementSession[] | null>(null)
  // Why: setState after unmount warns in dev and leaks state updates. The ref
  // is checked in every async callback before mutating component state.
  const isMounted = useRef(true)
  // Why: suppress background refresh() results from stomping an in-flight
  // mutation's optimistic UI. If Kill All has set sessions=[] optimistically
  // and a user-triggered refresh resolves with the pre-kill list, we'd flash
  // the list back in before the mutation resolves.
  const mutationInFlight = useRef(false)

  // Why: mirrors SessionsStatusSegment's navigation path so clicking a row
  // lands the user on the same terminal pane the status-bar popover would.
  // We need three store slices: `ptyIdsByTabId` to reverse-map sessionId →
  // tabId, `tabsByWorktree` to walk that tabId back to its owning worktree,
  // and the tab/view setters plus closeSettingsPage to actually switch
  // surfaces. Keeping this logic aligned with the status bar means the two
  // entry points can't drift on what "go to this session" means.
  const tabsByWorktree = useAppStore((s) => s.tabsByWorktree)
  const ptyIdsByTabId = useAppStore((s) => s.ptyIdsByTabId)
  const setActiveTab = useAppStore((s) => s.setActiveTab)
  const setActiveView = useAppStore((s) => s.setActiveView)
  const closeSettingsPage = useAppStore((s) => s.closeSettingsPage)

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

  const handleNavigate = useCallback(
    (tabId: string) => {
      const worktreeId = tabIdToWorktreeId.get(tabId)
      if (worktreeId) {
        // Why: match SessionsStatusSegment — route through the shared
        // activation path before switching tab so the worktree container
        // is mounted by the time setActiveTab runs.
        activateAndRevealWorktree(worktreeId)
      }
      setActiveView('terminal')
      setActiveTab(tabId)
      // Why: the status-bar version doesn't need this because it's already
      // rendered over the terminal surface; from the Settings pane the user
      // would otherwise land on their pane with the modal still covering it.
      closeSettingsPage()
    },
    [tabIdToWorktreeId, setActiveView, setActiveTab, closeSettingsPage]
  )

  useEffect(() => {
    isMounted.current = true
    return () => {
      isMounted.current = false
    }
  }, [])

  const refresh = useCallback(async (): Promise<PtyManagementSession[]> => {
    setIsRefreshing(true)
    try {
      const result = await window.api.pty.management.listSessions()
      if (!isMounted.current || mutationInFlight.current) {
        return result.sessions
      }
      setSessions(result.sessions)
      return result.sessions
    } catch (err) {
      console.error('[manage-sessions] listSessions failed', err)
      if (isMounted.current && !mutationInFlight.current) {
        toast.error('Couldn’t load sessions.', {
          description: err instanceof Error ? err.message : undefined
        })
      }
      return []
    } finally {
      if (isMounted.current) {
        setIsRefreshing(false)
        setHasLoadedOnce(true)
      }
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const sessionCount = sessions.length

  // Why: shared hook owns the daemon-wide restart + kill-all flows so the
  // status-bar segment and this settings pane can't drift on copy, IPC calls,
  // or the anti-dismiss guard. We pass lifecycle callbacks to keep the pane's
  // optimistic setSessions([]) + rollback pattern local to the component.
  const daemonActions = useDaemonActions({
    onKillAllStart: () => {
      mutationInFlight.current = true
      optimisticRollback.current = sessions
      setSessions([])
    },
    onKillAllError: () => {
      if (isMounted.current && optimisticRollback.current) {
        setSessions(optimisticRollback.current)
      }
    },
    onKillAllSettled: () => {
      optimisticRollback.current = null
      mutationInFlight.current = false
      void refresh()
    },
    onRestartSettled: () => {
      void refresh()
    }
  })

  const handleKillOne = useCallback(
    async (session: PtyManagementSession) => {
      setBusyKind('killOne')
      mutationInFlight.current = true
      try {
        const { success } = await window.api.pty.management.killOne({
          sessionId: session.sessionId
        })
        if (success) {
          toast.success('Killed session.')
        } else {
          toast.error('Couldn’t kill session — it may already be gone.')
        }
        mutationInFlight.current = false
        await refresh()
      } catch (err) {
        toast.error('Couldn’t kill session.', {
          description: err instanceof Error ? err.message : undefined
        })
      } finally {
        mutationInFlight.current = false
        if (isMounted.current) {
          setBusyKind(null)
          setConfirm(null)
        }
      }
    },
    [refresh]
  )

  // Why: do NOT clear `confirm` here — the dialog must stay open for the
  // duration of the mutation so the spinner + busyLabel render and the
  // anti-dismiss guard can actually hold. handleKillOne's `finally` clears
  // `confirm` when the op resolves.
  const runConfirmed = useCallback(() => {
    if (!confirm) {
      return
    }
    void handleKillOne(confirm.session)
  }, [confirm, handleKillOne])

  const copy = useMemo(() => getConfirmCopy(confirm), [confirm])
  const isBusy = busyKind !== null || daemonActions.isBusy

  return (
    <section className="space-y-4">
      <div className="space-y-1">
        <h3 className="text-sm font-semibold">Manage Sessions</h3>
        <p className="text-xs text-muted-foreground">
          Recover from a frozen or misbehaving terminal by killing sessions or restarting the
          underlying daemon.
        </p>
      </div>

      <SearchableSetting
        title="Daemon sessions running"
        description="Count of live PTY sessions across all workspaces."
        keywords={['daemon', 'pty', 'sessions', 'manage', 'kill', 'restart', 'terminal']}
        className="space-y-3"
      >
        {/* Why: full-width sessions card. The table *is* the primary
            surface — header bar on top carries the global actions (Kill
            all, Restart daemon) plus the session count and refresh; the
            body is the per-session list with a kill X on each row. Keeps
            destructive-color outside the trigger buttons; confirm Dialog
            still does the shouting. */}
        <div className="flex flex-col overflow-hidden rounded-lg border border-border/60">
          <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b border-border/60 px-3 py-2">
            <div className="flex items-center gap-2">
              <span className="text-xs font-medium text-muted-foreground">
                Sessions
                {hasLoadedOnce ? <span className="ml-1 tabular-nums">({sessionCount})</span> : null}
              </span>
              <Button
                variant="ghost"
                size="icon-xs"
                onClick={() => void refresh()}
                disabled={isBusy || isRefreshing}
                aria-label="Refresh"
                className="text-muted-foreground"
              >
                <RefreshCw className={isRefreshing ? 'animate-spin' : ''} />
              </Button>
            </div>
            {/* Why: icon-only ghost buttons keep this row visually quiet —
                the table is the hero, not the actions. Trash2 reads as
                "bulk delete" (matches its use elsewhere in the app) and
                RotateCw reads as "restart/cycle" without colliding with
                the RefreshCw list-refresh icon. Tooltip carries the verb
                since the glyph alone is ambiguous. */}
            <div className="flex items-center gap-1">
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    disabled={isBusy || sessionCount === 0}
                    onClick={() => daemonActions.setPending('killAll')}
                    aria-label="Kill all sessions"
                    className="text-muted-foreground hover:text-destructive"
                  >
                    {daemonActions.busyKind === 'killAll' ? (
                      <LoaderCircle className="animate-spin" />
                    ) : (
                      <Trash2 />
                    )}
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="bottom" sideOffset={6}>
                  Kill all sessions
                </TooltipContent>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    disabled={isBusy}
                    onClick={() => daemonActions.setPending('restart')}
                    aria-label="Restart daemon"
                    className="text-muted-foreground"
                  >
                    {daemonActions.busyKind === 'restart' ? (
                      <LoaderCircle className="animate-spin" />
                    ) : (
                      <RotateCw />
                    )}
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="bottom" sideOffset={6}>
                  Restart daemon
                </TooltipContent>
              </Tooltip>
            </div>
          </div>

          {!hasLoadedOnce ? (
            <div className="flex items-center justify-center px-3 py-8 text-xs text-muted-foreground">
              Loading…
            </div>
          ) : sessions.length === 0 ? (
            <div className="flex items-center justify-center px-3 py-8 text-xs text-muted-foreground">
              No sessions.
            </div>
          ) : (
            <div className="max-h-[360px] overflow-y-auto">
              <table className="w-full text-xs">
                <tbody>
                  {sessions.map((session) => {
                    // Why: mirror status-bar SessionsStatusSegment exactly —
                    // green when alive, muted when not. No amber "starting"
                    // bucket; the status bar doesn't have one either and
                    // adding one here made every row render amber whenever
                    // shellState wasn't exactly 'ready'.
                    const dotClass = session.isAlive ? 'bg-emerald-500' : 'bg-muted-foreground/40'
                    // Why: only sessions bound to a live tab have somewhere
                    // to navigate to. Orphan/unbound sessions (worktree was
                    // closed, tab store hasn't rehydrated, etc.) get no
                    // hover affordance and no click handler — same rule the
                    // status-bar popover follows.
                    const tabId = ptyIdToTabId.get(session.sessionId) ?? null
                    const rowClickable = tabId !== null
                    return (
                      <tr
                        key={session.sessionId}
                        className={`border-t border-border/50 first:border-t-0 ${
                          rowClickable ? 'cursor-pointer hover:bg-accent/60' : ''
                        }`}
                        onClick={rowClickable ? () => handleNavigate(tabId) : undefined}
                        aria-label={
                          rowClickable ? `Go to terminal ${formatWorkspace(session)}` : undefined
                        }
                      >
                        <td className="px-3 py-1.5">
                          <span
                            className={`block size-1.5 rounded-full ${dotClass}`}
                            aria-label={formatState(session)}
                            title={formatState(session)}
                          />
                        </td>
                        <td className="px-3 py-1.5">
                          <span className="truncate font-mono font-medium">
                            {formatWorkspace(session)}
                          </span>
                        </td>
                        <td
                          className="px-3 py-1.5 font-mono text-[11px] text-muted-foreground"
                          title={session.sessionId}
                        >
                          <span className="block max-w-[280px] truncate">{session.sessionId}</span>
                        </td>
                        <td className="px-3 py-1.5 text-right">
                          <Button
                            variant="ghost"
                            size="icon-xs"
                            onClick={(e) => {
                              // Why: kill X lives inside the clickable row;
                              // without stopPropagation the kill click would
                              // also fire handleNavigate and dismiss Settings.
                              e.stopPropagation()
                              setConfirm({ kind: 'killOne', session })
                            }}
                            disabled={isBusy}
                            aria-label={`Kill session ${session.sessionId}`}
                            className="text-muted-foreground hover:text-destructive"
                          >
                            <X />
                          </Button>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </SearchableSetting>

      <Dialog
        open={confirm !== null}
        onOpenChange={(open) => {
          if (open) {
            return
          }
          // Why: don't let overlay click / Escape / close-button close the
          // dialog mid-mutation — the confirm button is the canonical exit.
          // Matches the "can't cancel a destructive op in flight" convention
          // in other confirm dialogs across the app.
          if (isBusy) {
            return
          }
          setConfirm(null)
        }}
      >
        <DialogContent
          className="max-w-md"
          showCloseButton={!isBusy}
          onPointerDownOutside={(e) => {
            if (isBusy) {
              e.preventDefault()
            }
          }}
          onEscapeKeyDown={(e) => {
            if (isBusy) {
              e.preventDefault()
            }
          }}
        >
          {copy ? (
            <>
              <DialogHeader>
                <DialogTitle className="text-sm">{copy.title}</DialogTitle>
                <DialogDescription className="text-xs">{copy.description}</DialogDescription>
              </DialogHeader>
              <DialogFooter>
                <Button variant="outline" onClick={() => setConfirm(null)} disabled={isBusy}>
                  Cancel
                </Button>
                <Button variant="destructive" onClick={runConfirmed} disabled={isBusy}>
                  {isBusy ? <LoaderCircle className="size-4 animate-spin" /> : null}
                  {isBusy ? copy.busyLabel : copy.confirmLabel}
                </Button>
              </DialogFooter>
            </>
          ) : null}
        </DialogContent>
      </Dialog>
      <DaemonActionDialog api={daemonActions} />
    </section>
  )
}
