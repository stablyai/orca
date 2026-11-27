import type React from 'react'
import { Fragment } from 'react'
import { useTranslate, type Translate } from '@/i18n/use-translate'
import { getRemoteServerNewerThanClientVersion } from '@/runtime/hosts/updates/remote-server-version-skew'
import type { RemoteServerUpdateEntry } from '@/runtime/hosts/updates/remote-server-update-coordinator'
import { UPDATING_PHASES, getSessionsMayDropLabel } from './server-restart-copy'

type SummaryPart = { id: string; text: string; count: number; destructive?: boolean }

function serverSummaryParts(entries: RemoteServerUpdateEntry[], t: Translate): SummaryPart[] {
  const count = (phase: RemoteServerUpdateEntry['phase']): number =>
    entries.filter((entry) => entry.phase === phase).length
  const available = count('available')
  const failed = count('failed')
  const settled = entries.filter((entry) => entry.phase === 'current' || entry.phase === 'updated')
  // A newer server needs nothing from its own updater; this app is the one behind.
  const newer = settled.filter((entry) => getRemoteServerNewerThanClientVersion(entry)).length
  const current = settled.length - newer
  const manual = count('manual')
  const offline = count('offline')
  const parts: SummaryPart[] = [
    // First, so the narrow summary never folds a failure into "N other".
    {
      id: 'failed',
      count: failed,
      destructive: true,
      text: t('settings.about.servers.failedCount', '{{value0}} failed', { value0: failed })
    },
    {
      id: 'available',
      count: available,
      text: t('settings.about.servers.readyCount', '{{value0}} ready', {
        value0: available
      })
    },
    {
      id: 'current',
      count: current,
      text: t(
        'auto.components.settings.GeneralRemoteServerUpdates.currentCount',
        '{{value0}} up to date',
        { value0: current }
      )
    },
    {
      id: 'newer',
      count: newer,
      text: t(
        'auto.components.settings.GeneralRemoteServerUpdates.newerCount',
        '{{value0}} newer than this app',
        { value0: newer }
      )
    },
    {
      id: 'manual',
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
      id: 'offline',
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
      id: 'total',
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

function SummaryText({ part }: { part: SummaryPart }): React.JSX.Element {
  return part.destructive ? <span className="text-destructive">{part.text}</span> : <>{part.text}</>
}

/** All counts; when narrow, the first count plus the rest folded into "N other" so none disappear. */
function ServerSummary({ parts }: { parts: SummaryPart[] }): React.JSX.Element {
  const t = useTranslate()
  const [first, ...rest] = parts
  const other = rest.reduce((total, part) => total + part.count, 0)
  return (
    <>
      <span className={rest.length > 0 ? '@max-xs/about-row:hidden' : undefined}>
        {parts.map((part, index) => (
          <Fragment key={part.id}>
            {index > 0 ? ' · ' : null}
            <SummaryText part={part} />
          </Fragment>
        ))}
      </span>
      {rest.length > 0 ? (
        <span className="hidden @max-xs/about-row:inline">
          <SummaryText part={first} />
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

/** The Servers subtitle: the restart warning while Update all is armed, progress while updates run, else counts. */
export function ServerUpdateSummary({
  entries,
  armed
}: {
  entries: RemoteServerUpdateEntry[]
  armed: boolean
}): React.JSX.Element {
  const t = useTranslate()
  if (armed) {
    return <span className="text-status-warning-text">{getSessionsMayDropLabel(t)}</span>
  }
  const updating = entries.filter((entry) => UPDATING_PHASES.has(entry.phase)).length
  if (updating > 0) {
    return (
      <UpdatingSummary
        updating={updating}
        failed={entries.filter((entry) => entry.phase === 'failed').length}
      />
    )
  }
  return <ServerSummary parts={serverSummaryParts(entries, t)} />
}
