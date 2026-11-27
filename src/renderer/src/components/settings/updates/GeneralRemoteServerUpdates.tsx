import type React from 'react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Loader2, RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useAppStore } from '@/store/index'
import { useTranslate, type Translate } from '@/i18n/use-translate'
import {
  getUpdateCheckClickOptions,
  getUpdateCheckHint
} from '@/app-shell/updates/update-check-click-options'
import { getRemoteServerNewerThanClientVersion } from '@/runtime/hosts/updates/remote-server-version-skew'
import type { RemoteServerUpdateEntry } from '@/runtime/hosts/updates/remote-server-update-coordinator'
import type { RemoteServerUpdateCheck } from '@/store/slices/runtime-host-updates/remote-server-updates'
import type { UpdateCheckOptions } from '../../../../../shared/updater/update-status-types'
import { SearchableSetting } from '../section-layout/SearchableSetting'
import { AboutDisclosureRow } from './AboutDisclosureRow'
import { RemoteServerAboutRow } from './RemoteServerAboutRow'
import { ServerRestartButton } from './ServerRestartButton'
import {
  UPDATING_PHASES,
  getServerRestartQuestion,
  getSessionsMayDropLabel
} from './server-restart-copy'

const isEligible = (entry: RemoteServerUpdateEntry): boolean =>
  entry.phase === 'available' || entry.phase === 'failed'

type Snapshot =
  | { phase: 'owed' | 'failed' }
  | { phase: 'running'; request: Promise<RemoteServerUpdateCheck | undefined> }
  | { phase: 'ready'; check: RemoteServerUpdateCheck }

type SummaryPart = { text: string; count: number }

function serverSummaryParts(entries: RemoteServerUpdateEntry[], t: Translate): SummaryPart[] {
  const count = (phase: RemoteServerUpdateEntry['phase']): number =>
    entries.filter((entry) => entry.phase === phase).length
  const available = entries.filter(isEligible).length
  const settled = entries.filter((entry) => entry.phase === 'current' || entry.phase === 'updated')
  // A newer server needs nothing from its own updater; this app is the one behind.
  const newer = settled.filter((entry) => getRemoteServerNewerThanClientVersion(entry)).length
  const current = settled.length - newer
  const manual = count('manual')
  const offline = count('offline')
  const parts: SummaryPart[] = [
    {
      count: available,
      text: t('settings.about.servers.readyCount', '{{value0}} ready', {
        value0: available
      })
    },
    {
      count: current,
      text: t(
        'auto.components.settings.GeneralRemoteServerUpdates.currentCount',
        '{{value0}} up to date',
        { value0: current }
      )
    },
    {
      count: newer,
      text: t(
        'auto.components.settings.GeneralRemoteServerUpdates.newerCount',
        '{{value0}} newer than this app',
        { value0: newer }
      )
    },
    {
      count: manual,
      text: t(
        'auto.components.settings.GeneralRemoteServerUpdates.manualCount',
        '{{value0}} manual',
        {
          value0: manual
        }
      )
    },
    {
      count: offline,
      text: t(
        'auto.components.settings.GeneralRemoteServerUpdates.offlineCount',
        '{{value0}} offline',
        { value0: offline }
      )
    }
  ].filter((part) => part.count > 0)
  if (parts.length > 0) {
    return parts
  }
  return [
    {
      count: entries.length,
      text:
        entries.length === 1
          ? t(
              'auto.components.settings.GeneralRemoteServerUpdates.serverCountOne',
              '1 paired server'
            )
          : t(
              'auto.components.settings.GeneralRemoteServerUpdates.serverCount',
              '{{value0}} paired servers',
              { value0: entries.length }
            )
    }
  ]
}

/** All counts; when narrow, the first count plus the rest folded into "N other" so none disappear. */
function ServerSummary({ parts }: { parts: SummaryPart[] }): React.JSX.Element {
  const t = useTranslate()
  const [first, ...rest] = parts
  const other = rest.reduce((total, part) => total + part.count, 0)
  return (
    <>
      <span className={rest.length > 0 ? '@max-xs/about-row:hidden' : undefined}>
        {parts.map((part) => part.text).join(' · ')}
      </span>
      {rest.length > 0 ? (
        <span className="hidden @max-xs/about-row:inline">
          {first.text}
          {' · '}
          {t('settings.about.servers.otherCount', '{{value0}} other', {
            value0: other
          })}
        </span>
      ) : null}
    </>
  )
}

/** While updates run: "2 updating · 1 failed", with the failures in red. */
function UpdatingSummary({
  updating,
  failed
}: {
  updating: number
  failed: number
}): React.JSX.Element {
  const t = useTranslate()
  return (
    <>
      {t('settings.about.servers.updatingCount', '{{value0}} updating', {
        value0: updating
      })}
      {failed > 0 ? (
        <>
          {' · '}
          <span className="text-destructive">
            {t('settings.about.servers.failedCount', '{{value0}} failed', {
              value0: failed
            })}
          </span>
        </>
      ) : null}
    </>
  )
}

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
  const toggleRef = useRef<HTMLButtonElement>(null)
  const bulkActionRef = useRef<HTMLDivElement>(null)
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

  if (entries.length === 0) {
    return null
  }

  const focusServers = (): void => toggleRef.current?.focus()
  const disarm = (): void => setArmed(null)
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
          label={t('settings.about.servers.updateAll', 'Update all')}
          armedLabel={t('settings.about.servers.restartCount', 'Restart {{count}}?', {
            count: eligible.length
          })}
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

  const updatingCount = entries.filter((entry) => UPDATING_PHASES.has(entry.phase)).length
  const summary = allArmed ? (
    <span className="text-status-warning-text">{getSessionsMayDropLabel(t)}</span>
  ) : updatingCount > 0 ? (
    <UpdatingSummary
      updating={updatingCount}
      failed={entries.filter((entry) => entry.phase === 'failed').length}
    />
  ) : (
    <ServerSummary parts={serverSummaryParts(entries, t)} />
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
        summary={summary}
        open={open}
        onOpenChange={setOpenAndRefresh}
        control={action}
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
