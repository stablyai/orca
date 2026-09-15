import { useEffect, useState } from 'react'
import type { AiVaultSearchStatus } from '../../../../shared/ai-vault-search-types'
import { LOCAL_EXECUTION_HOST_ID } from '../../../../shared/execution-host'
import { useWindowStreamVisible } from '@/hooks/use-window-stream-visibility'
import { installWindowVisibilityInterval } from '@/lib/window-visibility-interval'
import { translate } from '@/i18n/i18n'
import { SettingsRow } from './SettingsFormControls'

const SWEEPING_POLL_MS = 2_000
const SETTLED_POLL_MS = 10_000

// A pass still has files due, so counts move between polls; a settled index only changes on the next sweep.
function isSweeping(status: AiVaultSearchStatus | null): boolean {
  if (!status?.enabled) {
    return false
  }
  return status.phase === 'indexing' || (status.phase === 'degraded' && status.filesDue > 0)
}

function sweepMessage(status: AiVaultSearchStatus): string {
  if (status.lastSweepCompletedAt === null) {
    // No completed sweep yet, so the denominator is still growing and a percentage would mislead.
    return translate('sessionHistory.status.firstScan', 'Indexing… {{indexed}} files so far', {
      indexed: status.filesIndexed
    })
  }
  const total = status.filesIndexed + status.filesDue + status.filesFailed
  const percent = total > 0 ? Math.floor((status.filesIndexed / total) * 100) : 0
  return translate(
    'sessionHistory.status.progress',
    'Indexing · {{percent}}% · {{indexed}} of {{total}} files',
    { percent, indexed: status.filesIndexed, total }
  )
}

function statusMessage(status: AiVaultSearchStatus): string {
  if (!status.enabled || status.phase === 'idle' || status.phase === 'closed') {
    return translate(
      'sessionHistory.status.unavailable',
      'Index is not ready or the search service is unavailable.'
    )
  }
  if (isSweeping(status)) {
    return sweepMessage(status)
  }
  return translate('sessionHistory.status.upToDate', 'Up to date · {{indexed}} files indexed', {
    indexed: status.filesIndexed
  })
}

export function SessionHistoryIndexStatus({
  enabled,
  refresh
}: {
  enabled: boolean
  refresh: number
}): React.JSX.Element {
  const visible = useWindowStreamVisible(0)
  const [status, setStatus] = useState<AiVaultSearchStatus | null>(null)
  const [failed, setFailed] = useState(false)
  const intervalMs = isSweeping(status) ? SWEEPING_POLL_MS : SETTLED_POLL_MS
  useEffect(() => {
    if (!enabled) {
      setStatus(null)
      setFailed(false)
      return
    }
    if (!visible) {
      return
    }
    let disposed = false
    let inFlight = false
    async function read(): Promise<void> {
      if (inFlight || disposed) {
        return
      }
      inFlight = true
      try {
        const next = await Promise.resolve().then(() =>
          window.api.aiVault.searchStatus(LOCAL_EXECUTION_HOST_ID)
        )
        if (!disposed) {
          setStatus(next)
          setFailed(false)
        }
      } catch {
        if (!disposed) {
          setStatus(null)
          setFailed(true)
        }
      } finally {
        inFlight = false
      }
    }
    const stopPolling = installWindowVisibilityInterval({ run: () => void read(), intervalMs })
    return () => {
      disposed = true
      stopPolling()
    }
  }, [enabled, visible, refresh, intervalMs])

  let message = translate('sessionHistory.status.checking', 'Checking index…')
  if (!enabled) {
    message = translate(
      'sessionHistory.status.off',
      'Search is off. Any existing index copy is kept.'
    )
  } else if (failed) {
    message = translate('sessionHistory.status.error', 'Could not read index status. Retrying…')
  } else if (status) {
    message = statusMessage(status)
  }
  const live = enabled && status?.enabled === true
  return (
    <SettingsRow
      label={translate('sessionHistory.status.title', 'Index status')}
      description={
        <span role="status" className="space-y-1 block">
          <span className="block">{message}</span>
          {live && status.phase === 'degraded' && status.filesFailed > 0 ? (
            <span className="block">
              {translate(
                'sessionHistory.status.unreadable',
                '{{failed}} files could not be read and will be retried.',
                { failed: status.filesFailed }
              )}
            </span>
          ) : null}
          {live && isSweeping(status) ? (
            <span className="block text-muted-foreground">
              {translate(
                'sessionHistory.status.stopHint',
                'Turn off search to stop. Progress is kept and resumes when you turn it back on.'
              )}
            </span>
          ) : null}
          {live && status.degradedRoots.length > 0 ? (
            <span className="block">
              {translate('sessionHistory.status.roots', 'Unverified source roots: {{roots}}', {
                roots: status.degradedRoots.length
              })}
            </span>
          ) : null}
        </span>
      }
      control={null}
    />
  )
}
