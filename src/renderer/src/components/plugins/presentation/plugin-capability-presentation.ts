import { translate } from '@/i18n/i18n'
import { reachablePluginCapabilities } from '../../../../../shared/plugins/capabilities/plugin-capability-reach'
import type { PluginTrust } from './plugin-access-profile'

/** The grants a plugin of this trust can use; approvals never list the rest. */
export function shownPluginCapabilities<T extends { kind: string }>(
  capabilities: readonly T[],
  trust: Pick<PluginTrust, 'worker'> | null
): T[] {
  return trust?.worker
    ? [...capabilities]
    : reachablePluginCapabilities(capabilities, 'sandboxed-ui')
}

export function pluginCapabilityDescription(kind: string, fallback: string): string {
  switch (kind) {
    case 'workspace:read':
      return translate(
        'auto.components.settings.PluginConsentDialog.capability.workspaceRead',
        'Read workspace names, branches, and terminals'
      )
    case 'agent:read':
      return translate(
        'auto.components.settings.PluginConsentDialog.capability.agentsRead',
        'Get notified when agent status changes'
      )
    case 'terminal:send':
      return translate(
        'auto.components.settings.PluginConsentDialog.capability.terminalRun',
        'Run commands in your terminals, including SSH'
      )
    case 'notifications:show':
      return translate(
        'auto.components.settings.PluginConsentDialog.capability.notificationsShow',
        'Show desktop notifications'
      )
    case 'storage:own':
      return translate(
        'auto.components.settings.PluginConsentDialog.capability.storage',
        'Store its own data'
      )
    case 'secrets:own':
      return translate(
        'auto.components.settings.PluginConsentDialog.capability.secrets',
        'Store its own encrypted secrets'
      )
    case 'settings:own':
      return translate(
        'auto.components.settings.PluginConsentDialog.capability.settingsOwn',
        'Read and change its own settings'
      )
    default:
      return fallback
  }
}
