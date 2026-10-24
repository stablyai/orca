import { translate } from '@/i18n/i18n'

export function pluginCapabilityDescription(kind: string, fallback: string): string {
  switch (kind) {
    case 'workspace:read':
      return translate(
        'auto.components.settings.PluginConsentDialog.capability.workspaceRead',
        'Read the name, branch, and terminal list of your focused workspace, and get notified when workspaces are created or removed'
      )
    case 'agents:read':
      return translate(
        'auto.components.settings.PluginConsentDialog.capability.agentsRead',
        'Get notified when agent status changes'
      )
    case 'terminal:send':
      return translate(
        'auto.components.settings.PluginConsentDialog.capability.terminalRun',
        'Type and run commands in your terminals, local and SSH'
      )
    case 'notifications:show':
      return translate(
        'auto.components.settings.PluginConsentDialog.capability.notificationsShow',
        'Show desktop notifications labeled with the plugin name'
      )
    case 'storage:own':
      return translate(
        'auto.components.settings.PluginConsentDialog.capability.storage',
        "Store data in the plugin's own storage folder"
      )
    case 'secrets:own':
      return translate(
        'auto.components.settings.PluginConsentDialog.capability.secrets',
        "Store and read secrets in the plugin's own encrypted file"
      )
    case 'settings:own':
      return translate(
        'auto.components.settings.PluginConsentDialog.capability.settingsOwn',
        "Read and change the plugin's own settings"
      )
    default:
      return fallback
  }
}
