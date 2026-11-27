import type React from 'react'
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Loader2, RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useAppStore } from '@/store/index'
import { useTranslate } from '@/i18n/use-translate'
import {
  getUpdateCheckClickOptions,
  getUpdateCheckHint
} from '@/app-shell/updates/update-check-click-options'
import type { RemoteServerUpdateEntry } from '@/runtime/hosts/updates/remote-server-update-coordinator'
import type { RemoteServerUpdateCheck } from '@/store/slices/runtime-host-updates/remote-server-updates'
import type { UpdateCheckOptions } from '../../../../../shared/updater/update-status-types'
import { SearchableSetting } from '../section-layout/SearchableSetting'
import { AboutDisclosureRow } from './AboutDisclosureRow'
import { RemoteServerAboutRow } from './RemoteServerAboutRow'
import { ServerUpdateSummary } from './ServerUpdateSummary'
import { ServerRestartButton } from './ServerRestartButton'
import { getServerRestartQuestion } from './server-restart-copy'

const isEligible = (entry: RemoteServerUpdateEntry): boolean =>
  entry.phase === 'available' || entry.phase === 'failed'

type Snapshot =
  | { phase: 'owed' | 'failed' }
  | { phase: 'running'; request: Promise<RemoteServerUpdateCheck | undefined> }
  | { phase: 'ready'; check: RemoteServerUpdateCheck }

/** Which button is waiting for its second click, bound to the servers it would restart. */
type Armed = {
  /** One server's id, or null for Update all. */
  serverId: string | null
  key: string
}

export function GeneralRemoteServerUpdates(): React.JSX.Element | null {
  const t = useTranslate()
  const entryMap = useAppStore((state) => state.remoteServerUpdates)
  const entries = [...entryMap.values()]
  const checking = useAppStore((state) => state.remoteServerUpdatesChecking)
  const running = useAppStore((state) => state.remoteServerUpdatesRunning)
  const revision = useAppStore((state) => state.remoteServerUpdatesCheckRevision)
  const refresh = useAppStore((state) => state.refreshRemoteServerUpdates)
  const start = useAppStore((state) => state.startRemoteServerUpdates)
  const setDialogOpen = useAppStore((state) => state.setRemoteServerUpdateDialogOpen)
  const [open, setOpen] = useState(false)
  const [armed, setArmed] = useState<Armed | null>(null)
  const disarm = useCallback((): void => setArmed(null), [])
  const toggleRef = useRef<HTMLButtonElement>(null)
  const bulkActionRef = useRef<HTMLDivElement>(null)
  const actionRef = useRef<HTMLDivElement>(null)
  // Set while keyboard focus is in the header action; a removed button leaves it set.
  const actionHadFocus = useRef(false)
  const [snapshot, setSnapshot] = useState<Snapshot>({ phase: 'owed' })
  const refreshSnapshot = useCallback(
    (options?: UpdateCheckOptions): void => {
      const request = refresh(options, {
        preserveFailureDetails: options === undefined
      })
      setSnapshot({ phase: 'running', request })
      const settle = (next: Snapshot): void => {
        // Folding or another Check disowns this result, even if it settles during a reopen.
        setSnapshot((current) =>
          current.phase === 'running' && current.request === request ? next : current
        )
      }
      void request.then(
        (check) => settle(check ? { phase: 'ready', check } : { phase: 'owed' }),
        () => settle({ phase: 'failed' })
      )
    },
    [refresh]
  )
  const needsSnapshot = snapshot.phase === 'owed'
  useEffect(() => {
    if (!open || !needsSnapshot || checking || running) {
      return
    }
    const store = useAppStore.getState()
    if (store.remoteServerUpdatesChecking || store.remoteServerUpdatesRunning) {
      return
    }
    refreshSnapshot()
  }, [open, needsSnapshot, checking, running, refreshSnapshot])

  // A modifier-click Check picks a one-off release track; closing the dialog clears it, and so
  // does folding this list or leaving the page, so a later Update all can't inherit it.
  const clearCheckOptions = useCallback((): void => {
    if (!useAppStore.getState().remoteServerUpdateDialogOpen) {
      setDialogOpen(false)
    }
  }, [setDialogOpen])
  useEffect(() => clearCheckOptions, [clearCheckOptions])

  const eligible = entries.filter(isEligible)
  const busy = checking || running
  const authorizedCheck =
    snapshot.phase === 'ready' && snapshot.check.revision === revision ? snapshot.check : null
  const updatesBlocked = busy || !authorizedCheck
  // The compact header has one control. If its check failed or went stale, offer a fresh check.
  const needsRetry =
    eligible.length > 0 &&
    open &&
    !busy &&
    (snapshot.phase === 'failed' || (snapshot.phase === 'ready' && !authorizedCheck))
  const targetsOf = (serverId: string | null): RemoteServerUpdateEntry[] =>
    serverId === null ? eligible : eligible.filter((entry) => entry.environmentId === serverId)
  const keyOf = (servers: RemoteServerUpdateEntry[]): string =>
    servers.map((entry) => entry.environmentId).join('\n')
  // The question is bound to the servers it named: if that set changes, an update starts, the
  // list folds, or its check fails, it reverts unanswered and never re-arms by itself.
  if (
    armed &&
    (armed.key !== keyOf(targetsOf(armed.serverId)) ||
      running ||
      needsRetry ||
      (armed.serverId !== null && !open))
  ) {
    setArmed(null)
  }

  const hasEligible = entries.some(isEligible)
  // The header action swaps buttons when servers become eligible or updates start or finish. If
  // that unmounted the focused button, land on Servers instead of dropping focus to the page.
  useLayoutEffect(() => {
    const container = actionRef.current
    if (!container || !actionHadFocus.current) {
      return
    }
    const active = container.ownerDocument.activeElement
    if (active && active !== container.ownerDocument.body) {
      return
    }
    actionHadFocus.current = false
    toggleRef.current?.focus()
  }, [hasEligible, running])

  if (entries.length === 0) {
    return null
  }

  const focusServers = (): void => toggleRef.current?.focus()
  const arm = (serverId: string | null): void => {
    setArmed({ serverId, key: keyOf(targetsOf(serverId)) })
  }
  const confirm = (serverId: string | null): void => {
    const ids = targetsOf(serverId).map((entry) => entry.environmentId)
    if (busy || !authorizedCheck || ids.length === 0) {
      return
    }
    setArmed(null)
    // The armed button disappears as soon as its servers become queued.
    focusServers()
    void start(ids, authorizedCheck)
  }
  // Opening re-checks on the default track, as the dialog did, so targets and live-session
  // counts are never a stale snapshot from an earlier (possibly modifier) check.
  const setOpenAndRefresh = (next: boolean): void => {
    setOpen(next)
    setSnapshot({ phase: 'owed' })
    if (!next) {
      clearCheckOptions()
    }
  }

  const check = (event: React.MouseEvent<HTMLButtonElement>): void => {
    setOpen(true)
    refreshSnapshot(getUpdateCheckClickOptions(event))
  }
  const checkLabel = t('settings.about.action.checkForUpdates', 'Check for updates')
  const checkAction = (
    <Button
      ref={
        needsRetry
          ? (button) => {
              if (
                button &&
                bulkActionRef.current?.contains(button.ownerDocument.activeElement) &&
                button.getClientRects().length
              ) {
                button.focus()
              }
            }
          : undefined
      }
      type="button"
      variant="outline"
      size="sm"
      title={getUpdateCheckHint()}
      disabled={busy}
      onClick={(event) => {
        if (needsRetry) {
          focusServers()
        }
        check(event)
      }}
    >
      {checking ? <Loader2 className="animate-spin" /> : null}
      {t('settings.about.action.check', 'Check')}
    </Button>
  )
  // When only failed servers can act, the header names the same action as their rows.
  const onlyFailed = eligible.length > 0 && eligible.every((entry) => entry.phase === 'failed')
  const allArmed = armed !== null && armed.serverId === null
  // Rows carry their own progress while updates run, so the header drops its control.
  const action = running ? null : eligible.length > 0 ? (
    <div className="flex items-center gap-1">
      {allArmed ? null : (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="ghost-muted"
              size="icon-sm"
              className="@max-xs/about-row:hidden"
              aria-label={checkLabel}
              disabled={busy}
              onClick={check}
            >
              {busy ? <Loader2 className="animate-spin" /> : <RefreshCw />}
            </Button>
          </TooltipTrigger>
          <TooltipContent side="top" sideOffset={4} className="max-w-xs">
            {checkLabel}
            <span className="block text-muted-foreground">{getUpdateCheckHint()}</span>
          </TooltipContent>
        </Tooltip>
      )}
      {needsRetry ? <div className="hidden @max-xs/about-row:block">{checkAction}</div> : null}
      <div ref={bulkActionRef} className={needsRetry ? '@max-xs/about-row:hidden' : undefined}>
        <ServerRestartButton
          // One server reads as that server's own action, not "Update all" / "Restart 1?".
          label={
            onlyFailed
              ? eligible.length === 1
                ? t('auto.components.settings.RemoteServerUpdateDialog.retry', 'Retry')
                : t('settings.about.servers.retryAll', 'Retry all')
              : eligible.length === 1
                ? t('settings.about.action.update', 'Update')
                : t('settings.about.servers.updateAll', 'Update all')
          }
          restingName={
            eligible.length === 1
              ? onlyFailed
                ? t('settings.about.servers.retryOne', 'Retry {{name}}', { name: eligible[0].name })
                : t('settings.about.servers.updateOne', 'Update {{name}}', {
                    name: eligible[0].name
                  })
              : undefined
          }
          armedLabel={
            eligible.length === 1
              ? t('settings.about.servers.restartOne', 'Restart?')
              : t('settings.about.servers.restartCount', 'Restart {{count}}?', {
                  count: eligible.length
                })
          }
          question={getServerRestartQuestion(eligible, t)}
          armed={allArmed}
          disabled={open ? updatesBlocked : busy}
          confirmBlocked={updatesBlocked}
          disabledReason={checking ? t('settings.about.status.checking', 'Checking…') : checkLabel}
          onArm={() => {
            arm(null)
            // Arming from the folded header shows what would restart and re-checks it.
            if (!open) {
              setOpenAndRefresh(true)
            }
          }}
          onDisarm={disarm}
          onConfirm={() => confirm(null)}
        />
      </div>
    </div>
  ) : (
    checkAction
  )

  return (
    <SearchableSetting
      title={t(
        'auto.components.settings.GeneralRemoteServerUpdates.fdd271abf0',
        'Remote Orca servers'
      )}
      description={t(
        'auto.components.settings.GeneralRemoteServerUpdates.description',
        'Check and update paired Orca servers from this client.'
      )}
      keywords={['remote server', 'update all', 'paired', 'version']}
      className="@container/about-servers"
    >
      <AboutDisclosureRow
        label={t('settings.about.servers.title', 'Servers')}
        toggleRef={toggleRef}
        summary={<ServerUpdateSummary entries={entries} armed={allArmed} />}
        open={open}
        onOpenChange={setOpenAndRefresh}
        control={
          <div
            ref={actionRef}
            // Keeps the header's height when updates hide its button, so the rows below don't jump.
            className="flex min-h-8 items-center"
            onFocus={() => {
              actionHadFocus.current = true
            }}
            onBlur={(event) => {
              // Keep the flag only when the focused button itself was removed, so focus can be
              // restored; any other blur (to another control or the page) clears it.
              const blurred = event.target
              if (event.relatedTarget) {
                actionHadFocus.current = false
                return
              }
              requestAnimationFrame(() => {
                if (blurred.isConnected) {
                  actionHadFocus.current = false
                }
              })
            }}
          >
            {action}
          </div>
        }
      >
        {open
          ? entries.map((entry) => (
              <RemoteServerAboutRow
                key={entry.environmentId}
                entry={entry}
                armed={armed?.serverId === entry.environmentId}
                disabled={updatesBlocked}
                onArm={() => arm(entry.environmentId)}
                onDisarm={disarm}
                onConfirm={() => confirm(entry.environmentId)}
              />
            ))
          : null}
      </AboutDisclosureRow>
    </SearchableSetting>
  )
}
