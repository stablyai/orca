import { useEffect, useState } from 'react'
import type { PluginUsageReading } from '../../../../../shared/plugins/contributions/plugin-usage-provider-contribution'
import { usePluginUsageIcons } from './use-plugin-usage-icons'
import {
  toPluginUsageRosterProvider,
  type PluginUsageRosterProvider
} from './plugin-usage-roster-provider'
import type { OwnerUsageRateLimits } from './use-owner-usage-rate-limits'

const EMPTY: PluginUsageReading[] = []

export function usePluginUsageProviders(
  ownerUsage: OwnerUsageRateLimits
): PluginUsageRosterProvider[] {
  const local = ownerUsage.remoteOwner === null || ownerUsage.remoteOwner.wslDistro !== undefined
  const [readings, setReadings] = useState(EMPTY)

  useEffect(() => {
    const plugins = window.api?.plugins
    if (!plugins?.usageProviders || !plugins.onUsageProvidersChanged) {
      return
    }
    let snapshotCurrent = true
    const unsubscribe = plugins.onUsageProvidersChanged((next) => {
      snapshotCurrent = false
      setReadings(next)
    })
    void plugins.usageProviders().then(
      (next) => {
        if (snapshotCurrent) {
          setReadings(next)
        }
      },
      () => undefined
    )
    return () => {
      snapshotCurrent = false
      unsubscribe()
    }
  }, [])

  const ownedReadings = local ? readings : (ownerUsage.pluginUsageProviders ?? EMPTY)
  const icon = usePluginUsageIcons(
    ownedReadings,
    local ? null : (ownerUsage.remoteOwner?.environmentId ?? null)
  )
  return ownedReadings.map((reading) => toPluginUsageRosterProvider(reading, icon(reading)))
}
