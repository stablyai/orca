import { translate } from '@/i18n/i18n'
import type { Translate } from '@/i18n/use-translate'
import type { ResourceOwnerSplit } from './resource-owner-split'
import { formatMemory } from './resource-usage-metrics'

export type ResourceOwnerKey = 'orca' | 'agents' | 'yourProcesses' | 'otherApps'

export function resourceOwnerLabels(t: Translate = translate): Record<ResourceOwnerKey, string> {
  return {
    orca: t('resourceManager.owner.orca', 'Orca'),
    agents: t('resourceManager.owner.agents', 'Agents'),
    yourProcesses: t('resourceManager.owner.otherTerminals', 'Other terminals'),
    otherApps: t('resourceManager.owner.otherApps', 'Other apps and system')
  }
}

/** One line naming each owner, for the status-bar tooltip. */
export function formatOwnerSplitLine(split: ResourceOwnerSplit, t: Translate = translate): string {
  const labels = resourceOwnerLabels(t)
  return (['orca', 'agents', 'yourProcesses'] as const)
    .map((owner) => `${labels[owner]} ${formatMemory(split[owner].memory)}`)
    .join(' · ')
}
