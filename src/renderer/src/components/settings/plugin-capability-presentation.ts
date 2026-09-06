import { translate } from '@/i18n/i18n'

export function pluginCapabilityDescription(kind: string, fallback: string): string {
  switch (kind) {
    case 'workspace:read':
      return translate(
        'auto.components.settings.PluginConsentDialog.capability.workspaceRead',
        'Read the name, branch, terminal list, execution-host label, and agent labels of your focused worktree'
      )
    case 'terminal:send':
      return translate(
        'auto.components.settings.PluginConsentDialog.capability.terminalSend',
        'Type text into a terminal you can see (always a specific terminal)'
      )
    case 'notifications:show':
      return translate(
        'auto.components.settings.PluginConsentDialog.capability.notificationsShow',
        'Show desktop notifications labeled with the plugin name'
      )
    case 'storage':
      return translate(
        'auto.components.settings.PluginConsentDialog.capability.storage',
        "Store data in the plugin's own storage folder"
      )
    case 'secrets':
      return translate(
        'auto.components.settings.PluginConsentDialog.capability.secrets',
        "Store and read secrets in the plugin's own encrypted vault"
      )
    case 'events:subscribe':
      return translate(
        'auto.components.settings.PluginConsentDialog.capability.eventsSubscribe',
        'Get notified when worktrees are created or removed and when agent status changes'
      )
    case 'settings:own':
      return translate(
        'auto.components.settings.PluginConsentDialog.capability.settingsOwn',
        "Read and change the plugin's own settings"
      )
    case 'ui:focus':
      return translate(
        'auto.components.settings.PluginConsentDialog.capability.uiFocus',
        'Read the focused UI surface (kind, a truncated tab title, and optional worktree/agent join keys). Off unless you grant this permission.'
      )
    case 'sidecar':
      return translate(
        'auto.components.settings.PluginConsentDialog.capability.sidecar',
        'Publish sidecar frames (for example Discord presence) so a paired UI ' +
          'client can apply them on the machine that has Discord'
      )
    default:
      return fallback
  }
}
