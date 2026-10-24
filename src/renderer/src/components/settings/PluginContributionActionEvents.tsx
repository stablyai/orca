import { Zap } from 'lucide-react'
import type { PluginHostListEntry } from '../../../../preload/api-types'
import type { PluginEventName } from '../../../../shared/plugins/plugin-event-contribution'
import { translate } from '@/i18n/i18n'
import { DetailRow } from './PluginDetailSections'
import { useInstalledPluginManifest } from './use-plugin-contribution-source'

/** Events a worker plugin subscribed to; the host entry doesn't carry them, so read its manifest. */
export function usePluginWorkerEvents(plugin: PluginHostListEntry | null): PluginEventName[] {
  const manifest = useInstalledPluginManifest(
    plugin?.hasWorker ? plugin.pluginKey : null,
    plugin?.consentFingerprint ?? plugin?.source?.contentHash ?? null
  )
  // Why dedupe: one row per event name, even if a manifest lists the same event twice.
  return [...new Set(manifest?.contributes.events.map((event) => event.on) ?? [])]
}

function eventTitle(event: PluginEventName): string {
  switch (event) {
    case 'worktree.created':
      return translate(
        'auto.components.settings.PluginContributionActionEvents.worktreeCreated',
        'When a workspace is created'
      )
    case 'worktree.removed':
      return translate(
        'auto.components.settings.PluginContributionActionEvents.worktreeRemoved',
        'When a workspace is removed'
      )
    case 'agent.status.changed':
      return translate(
        'auto.components.settings.PluginContributionActionEvents.agentStatusChanged',
        'When an agent’s status changes'
      )
  }
}

/** One event subscription, in plain words; nothing to click, Orca delivers it on its own. */
export function PluginContributionEventRow({
  event
}: {
  event: PluginEventName
}): React.JSX.Element {
  return (
    <DetailRow
      icon={<Zap />}
      title={eventTitle(event)}
      detail={`${translate(
        'auto.components.settings.PluginContributionActionEvents.detail',
        'Background code runs'
      )} · ${event}`}
    />
  )
}
