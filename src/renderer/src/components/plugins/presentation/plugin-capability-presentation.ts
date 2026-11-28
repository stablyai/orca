import { translate } from '@/i18n/i18n'
import type { Translate } from '@/i18n/use-translate'
import { PLUGIN_CAPABILITY_DESCRIPTIONS } from '../../../../../shared/plugins/capabilities/plugin-capabilities'
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

export function pluginCapabilityDescription(
  kind: string,
  fallback: string,
  t: Translate = translate
): string {
  switch (kind) {
    case 'workspace:read':
      return t(
        'auto.components.settings.PluginConsentDialog.capability.workspaceRead',
        'Read workspace names, branches, and terminals'
      )
    case 'agent:read':
      return t(
        'auto.components.settings.PluginConsentDialog.capability.agentsRead',
        'Get notified when agent status changes'
      )
    case 'terminal:send':
      return t(
        'auto.components.settings.PluginConsentDialog.capability.terminalRun',
        'Run commands in your terminals, including SSH'
      )
    case 'terminal:read':
      return t(
        'auto.components.settings.PluginConsentDialog.capability.terminalRead',
        'Read the output of your terminals, including SSH'
      )
    case 'workspace:write':
      return t(
        'auto.components.settings.PluginConsentDialog.capability.workspaceWrite',
        'Open your workspaces and files, and run built-in commands'
      )
    case 'agent:launch':
      return t(
        'auto.components.settings.PluginConsentDialog.capability.agentLaunch',
        'Start agents in your workspaces, including SSH'
      )
    case 'notifications:show':
      return t(
        'auto.components.settings.PluginConsentDialog.capability.notificationsShow',
        'Show desktop notifications'
      )
    case 'storage:own':
      return t(
        'auto.components.settings.PluginConsentDialog.capability.storage',
        'Store its own data'
      )
    case 'secrets:own':
      return t(
        'auto.components.settings.PluginConsentDialog.capability.secrets',
        'Store its own encrypted secrets'
      )
    case 'settings:own':
      return t(
        'auto.components.settings.PluginConsentDialog.capability.settingsOwn',
        'Read and change its own settings'
      )
    case 'appearance:write':
      return t(
        'auto.components.settings.PluginConsentDialog.capability.appearanceWrite',
        PLUGIN_CAPABILITY_DESCRIPTIONS['appearance:write']
      )
    case 'workspace:create':
      return t(
        'auto.components.settings.PluginConsentDialog.capability.workspaceCreate',
        PLUGIN_CAPABILITY_DESCRIPTIONS['workspace:create']
      )
    case 'automation:read':
      return t(
        'auto.components.settings.PluginConsentDialog.capability.automationRead',
        PLUGIN_CAPABILITY_DESCRIPTIONS['automation:read']
      )
    case 'automation:write':
      return t(
        'auto.components.settings.PluginConsentDialog.capability.automationWrite',
        PLUGIN_CAPABILITY_DESCRIPTIONS['automation:write']
      )
    case 'history:read':
      return t(
        'auto.components.settings.PluginConsentDialog.capability.historyRead',
        PLUGIN_CAPABILITY_DESCRIPTIONS['history:read']
      )
    default:
      return fallback
  }
}
