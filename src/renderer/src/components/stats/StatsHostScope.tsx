import { useEffect, useLayoutEffect, useState } from 'react'
import { useAppStore } from '../../store'
import { useTranslate } from '@/i18n/use-translate'
import { usageHostKey } from '../../store/slices/usage/usage-host'
import type { StatsHostUsageSupport } from '../../store/slices/process-stats/stats'
import { subscribeRuntimeHostContactRegained } from '../../runtime/hosts/connections/runtime-host-contact-regained'
import type { RuntimeClientTarget } from '../../../../shared/remote-runtime/host-catalog/runtime-client-target'

export type StatsHost = {
  target: RuntimeClientTarget
  /** Null for this computer. */
  name: string | null
}

/** Points the stats store at `host`, rendering nothing until it does, so no other host's numbers show. */
export function StatsHostScope({
  host,
  children
}: {
  host: StatsHost
  /** `view` changes with every new store view, so panes keyed on it read again. */
  children: (usageSupport: StatsHostUsageSupport, view: number) => React.ReactNode
}): React.JSX.Element | null {
  const key = usageHostKey(host.target)
  const shown = useAppStore((state) => usageHostKey(state.statsHost) === key)
  const usageSupport = useAppStore((state) => state.statsHostUsageSupport)
  const view = useAppStore((state) => state.statsHostEpoch)
  const setStatsHost = useAppStore((state) => state.setStatsHost)
  const renewStatsHostView = useAppStore((state) => state.renewStatsHostView)
  const environmentId = host.target.kind === 'environment' ? host.target.environmentId : null
  // Why: until this mount's view starts, panes would mount under the previous one and read early.
  const [started, setStarted] = useState(false)
  // A remote host has no usage connection events; a new view reads it again when contact returns.
  useEffect(
    () =>
      environmentId
        ? subscribeRuntimeHostContactRegained(environmentId, renewStatsHostView)
        : undefined,
    [environmentId, renewStatsHostView]
  )
  // Layout effect: children's mount effects must already read this host. Showing the same remote
  // host again starts a new view, since its version or reachability may have changed meanwhile.
  useLayoutEffect(() => {
    if (environmentId === null) {
      setStatsHost({ kind: 'local' })
    } else if (usageHostKey(useAppStore.getState().statsHost) === key) {
      renewStatsHostView()
    } else {
      setStatsHost({ kind: 'environment', environmentId })
    }
    setStarted(true)
  }, [environmentId, key, setStatsHost, renewStatsHostView])
  return shown && started ? <>{children(usageSupport, view)}</> : null
}

export function StatsHostCaption({ name }: { name: string }): React.JSX.Element {
  const t = useTranslate()
  return (
    <p className="px-1 text-xs text-muted-foreground">
      {t(
        'auto.components.stats.StatsHostScope.remoteCaption',
        'Stats and usage recorded on {{value0}}. Enable and Refresh act on {{value0}}.',
        { value0: name }
      )}
    </p>
  )
}

export function StatsHostTooOldNotice({ name }: { name: string }): React.JSX.Element {
  const t = useTranslate()
  return (
    <div className="rounded-lg border border-border bg-card px-4 py-3">
      <p className="text-sm font-medium text-foreground">
        {t(
          'auto.components.stats.StatsHostScope.tooOldTitle',
          "{{value0}} can't report usage yet",
          { value0: name }
        )}
      </p>
      <p className="mt-1 text-xs text-muted-foreground">
        {t(
          'auto.components.stats.StatsHostScope.tooOldBody',
          'It runs an older version of Orca. Update Orca on {{value0}} to see its token usage here.',
          { value0: name }
        )}
      </p>
    </div>
  )
}
