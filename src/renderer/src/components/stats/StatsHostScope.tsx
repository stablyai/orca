import { useEffect, useLayoutEffect, useState } from 'react'
import { useAppStore } from '../../store'
import { useTranslate } from '@/i18n/use-translate'
import { usageHostKey } from '../../store/slices/usage/usage-host'
import { runtimeEnvironmentSupportsCapability } from '../../runtime/rpc/compatibility/runtime-capability-proof'
import { USAGE_ANALYTICS_RUNTIME_CAPABILITY } from '../../../../shared/remote-runtime/protocol/host-runtime-capabilities'
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
  children: (usageSupported: boolean | null) => React.ReactNode
}): React.JSX.Element | null {
  const key = usageHostKey(host.target)
  const shownKey = useAppStore((state) => usageHostKey(state.statsHost))
  const setStatsHost = useAppStore((state) => state.setStatsHost)
  const usageSupported = useHostUsageSupport(host.target)
  // Layout effect: children's mount effects must already read this host. Same-host calls are no-ops.
  useLayoutEffect(() => setStatsHost(host.target), [host.target, setStatsHost])
  return shownKey === key ? <>{children(usageSupported)}</> : null
}

/** Whether the host's Orca computes its own usage; null while asking. This computer always does. */
function useHostUsageSupport(target: RuntimeClientTarget): boolean | null {
  const environmentId = target.kind === 'environment' ? target.environmentId : null
  const [answer, setAnswer] = useState<{ environmentId: string; supported: boolean } | null>(null)
  useEffect(() => {
    if (!environmentId) {
      return
    }
    let active = true
    const settle = (supported: boolean): void => {
      if (active) {
        setAnswer({ environmentId, supported })
      }
    }
    runtimeEnvironmentSupportsCapability(environmentId, USAGE_ANALYTICS_RUNTIME_CAPABILITY)
      .then(settle)
      // An unreachable host is not an old one; the usage reads report that failure themselves.
      .catch(() => settle(true))
    return () => {
      active = false
    }
  }, [environmentId])
  if (!environmentId) {
    return true
  }
  return answer?.environmentId === environmentId ? answer.supported : null
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
