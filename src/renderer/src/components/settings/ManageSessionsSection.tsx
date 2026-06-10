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
import { ManageSessionsTable } from './ManageSessionsTable'
import { translate } from '@/i18n/i18n'

type ConfirmKind = 'killOne'

export function ManageSessionsSection(): React.JSX.Element {
  const activeRuntimeEnvironmentId = useAppStore(
    (s) => s.settings?.activeRuntimeEnvironmentId ?? null
  )
  const [sessions, setSessions] = useState<PtyManagementSession[]>([])
  const [isRefreshing, setIsRefreshing] = useState(true)
  const [hasLoadedOnce, setHasLoadedOnce] = useState(false)
  const [pendingKillSession, setPendingKillSession] = useState<PtyManagementSession | null>(null)
  const [busyKind, setBusyKind] = useState<ConfirmKind | null>(null)
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
    if (activeRuntimeEnvironmentId?.trim()) {
      if (isMounted.current) {
        setSessions([])
        setIsRefreshing(false)
        setHasLoadedOnce(true)
      }
      return []
    }
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
  }, [activeRuntimeEnvironmentId])

  useEffect(() => {
    void refresh()
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

  if (activeRuntimeEnvironmentId?.trim()) {
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
              'auto.components.settings.ManageSessionsSection.ad467eaadc',
              'Session management is unavailable while a remote runtime server is active.'
            )}
          </p>
        </div>
        <SearchableSetting
          title={getManageSessionsSearchEntries()[0].title}
          description={getManageSessionsSearchEntries()[0].description}
          keywords={getManageSessionsSearchEntries()[0].keywords}
          className="space-y-3"
        >
          <div className="rounded-lg border border-border/60 px-3 py-3 text-xs text-muted-foreground">
            {translate(
              'auto.components.settings.ManageSessionsSection.9c940434af',
              'Switch back to the local runtime to restart or kill local daemon sessions.'
            )}
          </div>
        </SearchableSetting>
      </section>
    )
  }

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
      >
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
