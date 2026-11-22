import { Bot, MessageCircleQuestion, Siren } from 'lucide-react'
import { useTranslate } from '@/i18n/use-translate'
import { useAppStateValue } from '@/store/retained-views/app-state-view'
import type { HostNotificationSettings } from '../../../../../shared/notifications/notification-settings-types'
import { SettingsGroup } from '../section-layout/SettingsGroup'
import { useServerSettingValue, type HostSettingsReply } from '../host-scope/use-host-setting'
import { NotificationSettingToggle } from './NotificationSettingToggle'

function readHostNotificationSettings(
  settings: HostSettingsReply
): HostNotificationSettings | undefined {
  const value = settings.hostNotifications
  return value &&
    typeof value.enabled === 'boolean' &&
    typeof value.agentTaskComplete === 'boolean' &&
    typeof value.agentNeedsInput === 'boolean' &&
    typeof value.terminalBell === 'boolean'
    ? {
        enabled: value.enabled,
        agentTaskComplete: value.agentTaskComplete,
        agentNeedsInput: value.agentNeedsInput,
        terminalBell: value.terminalBell
      }
    : undefined
}

/** A server's own switches: they decide which of its agents' alerts it sends, including phone pushes. */
export function ServerNotificationsPane({
  environmentId
}: {
  environmentId: string
}): React.JSX.Element {
  const t = useTranslate()
  const hostName = useAppStateValue(
    (state) => state.runtimeEnvironments.find((entry) => entry.id === environmentId)?.name
  )
  const host = hostName ?? t('components.settings.notifications.server.fallbackHost', 'this server')
  const { setting, update } = useServerSettingValue({
    environmentId,
    read: readHostNotificationSettings,
    updateFailedMessage: t(
      'components.settings.notifications.server.updateFailed',
      "Couldn't update notifications on {{host}}.",
      { host }
    )
  })
  const values = setting.state === 'ready' ? setting.value : null
  const toggle = (key: keyof HostNotificationSettings): void => {
    if (values) {
      void update({ hostNotifications: { [key]: !values[key] } })
    }
  }
  return (
    <SettingsGroup>
      <NotificationSettingToggle
        label={t('auto.components.settings.NotificationsPane.9c41a0d367', 'Enable notifications')}
        description={
          setting.state === 'unsupported'
            ? t(
                'components.settings.notifications.server.unsupported',
                'Update Orca on {{host}} to change its notifications here.',
                { host }
              )
            : t(
                'components.settings.notifications.server.enabledDescription',
                'Alerts {{host}} sends for its agents and terminals, including pushes to your phones.',
                { host }
              )
        }
        checked={values?.enabled ?? false}
        disabled={!values}
        onToggle={() => toggle('enabled')}
      />
      <NotificationSettingToggle
        icon={<Bot className="size-4" />}
        label={t('auto.components.settings.NotificationsPane.0acae1066d', 'Agent task complete')}
        description={t(
          'auto.components.settings.NotificationsPane.55f901a59b',
          'A coding agent finishes and becomes idle.'
        )}
        checked={values?.agentTaskComplete ?? false}
        disabled={!values?.enabled}
        onToggle={() => toggle('agentTaskComplete')}
      />
      <NotificationSettingToggle
        icon={<MessageCircleQuestion className="size-4" />}
        label={t('auto.components.settings.NotificationsPane.05f5c5ab50', 'Agent needs input')}
        description={t(
          'auto.components.settings.NotificationsPane.e1b1724793',
          'A coding agent asks for permission or has a question.'
        )}
        checked={values?.agentNeedsInput ?? false}
        disabled={!values?.enabled}
        onToggle={() => toggle('agentNeedsInput')}
      />
      <NotificationSettingToggle
        icon={<Siren className="size-4" />}
        label={t('auto.components.settings.NotificationsPane.6bc7bd7b6e', 'Terminal bell')}
        description={t(
          'auto.components.settings.NotificationsPane.b6fc369244',
          'A background terminal emits a bell character.'
        )}
        checked={values?.terminalBell ?? false}
        disabled={!values?.enabled}
        onToggle={() => toggle('terminalBell')}
      />
    </SettingsGroup>
  )
}
