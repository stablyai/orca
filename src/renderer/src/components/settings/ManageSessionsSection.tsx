import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import type { PtyManagementSession } from '../../../../preload/api-types'
import { SearchableSetting } from './SearchableSetting'
import { getManageSessionsSearchEntries } from './terminal-search'
import { useAppStore } from '../../store'
import { activateAndRevealWorktree } from '@/lib/worktree-activation'
import { activateTabAndFocusPane } from '@/lib/activate-tab-and-focus-pane'
import { useDaemonActions, DaemonActionDialog } from '../shared/useDaemonActions'
import { ManageSessionKillDialog } from './ManageSessionKillDialog'
import { DaemonDegradedNotice } from './DaemonDegradedNotice'
import { ManageSessionsTable } from './ManageSessionsTable'
import { notifyDaemonSessionInventoryInvalidated } from '../status-bar/daemon-session-inventory-invalidation'
import {
  MANAGE_SESSIONS_SECTION_ID,
  TerminalTccAttributionNotice
} from './TerminalTccAttributionNotice'
import { translate } from '@/i18n/i18n'

type ConfirmKind = 'killOne'

export function ManageSessionsSection(): React.JSX.Element {
  const [sessions, setSessions] = useState<PtyManagementSession[]>([])
  const [isDaemonDegraded, setIsDaemonDegraded] = useState(false)
  const [isRefreshing, setIsRefreshing] = useState(true)
  const [hasLoadedOnce, setHasLoadedOnce] = useState(false)
  const [pendingKillSession, setPendingKillSession] = useState<PtyManagementSession | null>(null)
  const [busyKind, setBusyKind] = useState<ConfirmKind | null>(null)
  const [attributionRefreshRevision, setAttributionRefreshRevision] = useState(0)
  const optimisticRollback = useRef<PtyManagementSession[] | null>(null)
  const isMounted = useRef(true)
  const mutationInFlight = useRef(false)

  const tabsByWorktree = useAppStore((s) => s.tabsByWorktree)
  const ptyIdsByTabId = useAppStore((s) => s.ptyIdsByTabId)
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
        activateAndRevealWorktree(worktreeId)
      }
      setActiveView('terminal')
      activateTabAndFocusPane(tabId, null)
      closeSettingsPage()
    },
    [tabIdToWorktreeId, setActiveView, closeSettingsPage]
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
      setIsDaemonDegraded(result.degraded === true)
      setSessions(result.sessions)
      return result.sessions
    } catch (err) {
      console.error('[manage-sessions] listSessions failed', err)
      if (isMounted.current && !mutationInFlight.current) {
        toast.error(
          translate(
            'auto.components.settings.ManageSessionsSection.c535cbdd09',
            'Couldn’t load sessions.'
          ),
          {
            description: err instanceof Error ? err.message : undefined
          }
        )
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

  // Why refetch on focus: the degraded flag is computed in the main process and never pushed.
  // DegradedDaemonFreshSpawnRouter.recover() clears it the moment the daemon answers a health
  // check, so a banner rendered at mount can outlive the condition — and it arms a Restart that
  // ends every live session. Matches TerminalTccAttributionNotice, which refetches for the same
  // reason: a daemon restart or drain changes the verdict without a pane remount.
  useEffect(() => {
    const onFocus = (): void => {
      void refresh()
    }
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [refresh])

  const sessionCount = sessions.length

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
      notifyDaemonSessionInventoryInvalidated()
      setAttributionRefreshRevision((revision) => revision + 1)
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
          toast.success(
            translate(
              'auto.components.settings.ManageSessionsSection.bfba05dccd',
              'Killed session.'
            )
          )
        } else {
          toast.error(
            translate(
              'auto.components.settings.ManageSessionsSection.0735b7a586',
              'Couldn’t kill session — it may already be gone.'
            )
          )
        }
        mutationInFlight.current = false
        notifyDaemonSessionInventoryInvalidated()
        await refresh()
      } catch (err) {
        toast.error(
          translate(
            'auto.components.settings.ManageSessionsSection.8dbd96b463',
            'Couldn’t kill session.'
          ),
          {
            description: err instanceof Error ? err.message : undefined
          }
        )
      } finally {
        mutationInFlight.current = false
        if (isMounted.current) {
          setBusyKind(null)
          setPendingKillSession(null)
        }
      }
    },
    [refresh]
  )

  const runConfirmed = useCallback(() => {
    if (!pendingKillSession) {
      return
    }
    void handleKillOne(pendingKillSession)
  }, [pendingKillSession, handleKillOne])

  const isBusy = busyKind !== null || daemonActions.isBusy

  return (
    <section className="space-y-4">
      <div className="space-y-1">
        <h3 className="text-sm font-semibold">
          {translate(
            'auto.components.settings.ManageSessionsSection.d1b80fd5cd',
            'Manage Sessions'
          )}
        </h3>
        <p className="text-xs text-muted-foreground">
          {translate(
            'auto.components.settings.ManageSessionsSection.7c4889a724',
            'Recover from a frozen or misbehaving terminal by killing sessions or restarting the underlying daemon.'
          )}
        </p>
      </div>

      <SearchableSetting
        title={getManageSessionsSearchEntries()[0].title}
        description={getManageSessionsSearchEntries()[0].description}
        keywords={getManageSessionsSearchEntries()[0].keywords}
        className="space-y-3"
        id={MANAGE_SESSIONS_SECTION_ID}
      >
        <TerminalTccAttributionNotice
          showManageSessionsButton={false}
          refreshRevision={attributionRefreshRevision}
        />
        <DaemonDegradedNotice
          degraded={isDaemonDegraded}
          isBusy={isBusy}
          onRestartDaemon={() => daemonActions.setPending('restart')}
        />
        <ManageSessionsTable
          sessions={sessions}
          hasLoadedOnce={hasLoadedOnce}
          sessionCount={sessionCount}
          isBusy={isBusy}
          isRefreshing={isRefreshing}
          daemonBusyKind={daemonActions.busyKind}
          ptyIdToTabId={ptyIdToTabId}
          onRefresh={() => void refresh()}
          onKillAll={() => daemonActions.setPending('killAll')}
          onRestartDaemon={() => daemonActions.setPending('restart')}
          onNavigate={handleNavigate}
          onRequestKill={setPendingKillSession}
        />
      </SearchableSetting>

      <ManageSessionKillDialog
        session={pendingKillSession}
        isBusy={isBusy}
        onCancel={() => setPendingKillSession(null)}
        onConfirm={runConfirmed}
      />
      <DaemonActionDialog api={daemonActions} />
    </section>
  )
}
