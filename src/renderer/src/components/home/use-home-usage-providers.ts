import { useEffect } from 'react'
import { useAppStore } from '@/store'
import { normalizeUsagePercentageDisplay } from '../../../../shared/usage-percentage-display'
import { useOwnerUsageRateLimits } from '../status-bar/use-owner-usage-rate-limits'
import {
  deriveUsageRosterProviders,
  type UsageRosterProviders
} from '../status-bar/usage-roster-providers'

/** Same provider roster the status bar Usage popover shows, without depending on the bar being visible. */
export function useHomeUsageProviders(): UsageRosterProviders & {
  usagePercentageDisplay: ReturnType<typeof normalizeUsagePercentageDisplay>
} {
  const localRateLimits = useAppStore((s) => s.rateLimits)
  const { rateLimits, remoteOwner } = useOwnerUsageRateLimits(localRateLimits)
  const settings = useAppStore((s) => s.settings)
  const statusBarItems = useAppStore((s) => s.statusBarItems)
  const localDetectedAgentIds = useAppStore((s) => s.detectedAgentIds)
  const ensureDetectedAgents = useAppStore((s) => s.ensureDetectedAgents)
  const usagePercentageDisplay = normalizeUsagePercentageDisplay(
    useAppStore((s) => s.usagePercentageDisplay)
  )

  useEffect(() => {
    void ensureDetectedAgents()
  }, [ensureDetectedAgents])

  const remoteOwned = remoteOwner !== null
  return {
    ...deriveUsageRosterProviders({
      rateLimits,
      remoteOwned,
      settings,
      statusBarItems,
      detectedAgentIds: remoteOwned ? null : localDetectedAgentIds
    }),
    usagePercentageDisplay
  }
}
