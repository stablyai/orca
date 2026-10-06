import type { NotificationSettings } from '../../../../shared/notification-settings-types'
import { translate } from '@/i18n/i18n'
import { NotificationSettingToggle } from './NotificationSettingToggle'

export function WorkspaceNotificationSettings({
  settings,
  onUpdate
}: {
  settings: NotificationSettings
  onUpdate: (updates: Partial<NotificationSettings>) => void | Promise<void>
}): React.JSX.Element {
  const disabled = !settings.enabled || !settings.agentTaskComplete
  return (
    <>
      <NotificationSettingToggle
        label={translate('settings.notifications.cliWorktrees', 'CLI-created Worktrees')}
        description={translate(
          'settings.notifications.cliWorktreesDescription',
          'Agent completion banners and phone pushes for worktrees created from the CLI.'
        )}
        checked={settings.cliWorktreeTaskComplete !== false}
        disabled={disabled}
        onToggle={() =>
          void onUpdate({ cliWorktreeTaskComplete: settings.cliWorktreeTaskComplete === false })
        }
      />
      <NotificationSettingToggle
        label={translate(
          'settings.notifications.automationWorktrees',
          'Automation-created Worktrees'
        )}
        description={translate(
          'settings.notifications.automationWorktreesDescription',
          'Agent completion banners and phone pushes for worktrees created by automations.'
        )}
        checked={settings.automationWorktreeTaskComplete !== false}
        disabled={disabled}
        onToggle={() =>
          void onUpdate({
            automationWorktreeTaskComplete: settings.automationWorktreeTaskComplete === false
          })
        }
      />
    </>
  )
}
