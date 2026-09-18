import type {
  PluginCapability,
  PluginCapabilityKind
} from '../../../../shared/plugins/plugin-capabilities'
import { PLUGIN_READ_MANDATORY_DENIED_PATH_LABELS } from '../../../../shared/plugins/plugin-read-confinement'
import { translate } from '@/i18n/i18n'

export function pluginCapabilityDescription(kind: PluginCapabilityKind, fallback: string): string {
  switch (kind) {
    case 'workspace:read':
      return translate(
        'auto.components.settings.PluginConsentDialog.capability.workspaceRead',
        'Read the name, branch, and terminal list of your focused worktree'
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
    case 'workspace:list':
      return translate(
        'auto.components.settings.PluginConsentDialog.capability.workspaceList',
        'Read the name, branch, and host of all your worktrees'
      )
    case 'files:read':
      return fallback
  }
}

type PluginCapabilityPresentationProps = {
  capability: PluginCapability
  fallback?: string
}

export function PluginCapabilityPresentation({
  capability,
  fallback = capability.kind
}: PluginCapabilityPresentationProps): React.JSX.Element {
  const isFilesRead = capability.kind === 'files:read'
  const wholeWorktree = isFilesRead && capability.paths.includes('**')
  const description = isFilesRead
    ? translate(
        'auto.components.settings.PluginConsentDialog.capability.filesRead',
        'Read files in your worktrees that match these patterns'
      )
    : pluginCapabilityDescription(capability.kind, fallback)
  const scopeLabel = wholeWorktree
    ? translate(
        'auto.components.settings.PluginConsentDialog.capability.wholeWorktree',
        'Whole worktree'
      )
    : translate(
        'auto.components.settings.PluginConsentDialog.capability.filePatterns',
        'File patterns'
      )
  const alwaysBlockedLabel = translate(
    'auto.components.settings.PluginConsentDialog.capability.alwaysBlocked',
    'Always blocked'
  )

  return (
    <div className="min-w-0">
      <span>{description}</span>{' '}
      <span className="font-mono text-[11px] text-muted-foreground">({capability.kind})</span>
      {isFilesRead ? (
        <div className="mt-2 space-y-2">
          <p className="text-[11px] font-semibold uppercase tracking-[0.05em] text-muted-foreground">
            {scopeLabel}
          </p>
          {wholeWorktree ? (
            <p className="text-xs leading-[1.5] text-muted-foreground">
              {translate(
                'auto.components.settings.PluginConsentDialog.capability.wholeWorktreeExplanation',
                'This plugin can read files throughout each worktree, except the sensitive paths Orca always blocks.'
              )}
            </p>
          ) : null}
          <ul aria-label={scopeLabel} className="space-y-2">
            {capability.paths.map((path, index) => (
              <li
                key={`${path}\u0000${index}`}
                className="break-all font-mono text-[11px] leading-[1.5] select-text"
              >
                {path}
              </li>
            ))}
          </ul>
          <p className="text-[11px] font-semibold uppercase tracking-[0.05em] text-muted-foreground">
            {alwaysBlockedLabel}
          </p>
          <p className="text-xs leading-[1.5] text-muted-foreground">
            {translate(
              'auto.components.settings.PluginConsentDialog.capability.blockedExplanation',
              'Orca blocks these sensitive path families even when a file pattern matches:'
            )}
          </p>
          <ul aria-label={alwaysBlockedLabel} className="space-y-2">
            {PLUGIN_READ_MANDATORY_DENIED_PATH_LABELS.map((path, index) => (
              <li
                key={`${path}\u0000${index}`}
                className="break-all font-mono text-[11px] leading-[1.5] select-text"
              >
                {path}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  )
}
