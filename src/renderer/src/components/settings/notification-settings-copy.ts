import { toast } from 'sonner'
import type { GlobalSettings } from '../../../../shared/types'
import { translate } from '@/i18n/i18n'

type SystemNotificationSettingsCopy = {
  failureTitle: string
  failureDescription: string
}

export function getSystemNotificationSettingsCopy(
  platform: NodeJS.Platform
): SystemNotificationSettingsCopy | null {
  if (platform === 'darwin') {
    return {
      failureTitle: 'macOS did not show the notification',
      failureDescription: 'Enable Allow notifications for Orca in System Settings.'
    }
  }

  if (platform === 'win32') {
    return {
      failureTitle: 'Windows did not show the notification',
      failureDescription: 'Enable notifications for Orca in Windows Settings.'
    }
  }

  return null
}

export type NotificationVolumeDraftState = {
  sourceVolume: number
  draft: number
}

export function createNotificationVolumeDraftState(
  sourceVolume: number
): NotificationVolumeDraftState {
  return {
    sourceVolume,
    draft: sourceVolume
  }
}

export function resolveNotificationVolumeDraftState(
  state: NotificationVolumeDraftState,
  sourceVolume: number
): NotificationVolumeDraftState {
  return state.sourceVolume === sourceVolume
    ? state
    : createNotificationVolumeDraftState(sourceVolume)
}

export async function sendNotificationSettingsTestNotification(
  notificationSettings: GlobalSettings['notifications'],
  volumeDraft: number
): Promise<void> {
  const permissionStatus = await window.api.notifications.getPermissionStatus()
  if (!permissionStatus.supported) {
    toast.error(
      translate(
        'auto.components.settings.NotificationsPane.c83b05a055',
        'Notifications are not supported on this system'
      )
    )
    return
  }

  const result = await window.api.notifications.dispatch({
    source: 'test',
    requireDisplayConfirmation: true
  })
  if (result.delivered) {
    const soundResult =
      notificationSettings.customSoundId !== 'system'
        ? await window.api.notifications.playSound({
            force: true,
            volume: volumeDraft
          })
        : null
    if (notificationSettings.customSoundId !== 'system' && soundResult && !soundResult.played) {
      toast.error(
        translate(
          'auto.components.settings.NotificationsPane.98d70fb261',
          'Custom notification sound could not be played'
        )
      )
      return
    }
    const settingsCopy = getSystemNotificationSettingsCopy(permissionStatus.platform)
    if (permissionStatus.platform === 'darwin' && settingsCopy) {
      toast.message(
        translate(
          'auto.components.settings.NotificationsPane.7f45542625',
          'Test notification requested'
        ),
        {
          description: translate(
            'auto.components.settings.NotificationsPane.115437bc35',
            'If no macOS banner appeared, enable Allow notifications for Orca.'
          ),
          action: {
            label: translate(
              'auto.components.settings.NotificationsPane.145227ca2b',
              'Open Settings'
            ),
            onClick: () => {
              void window.api.notifications.openSystemSettings()
            }
          }
        }
      )
      return
    }
    toast.success(
      translate('auto.components.settings.NotificationsPane.d3d54e0915', 'Test notification sent')
    )
    return
  }

  if (result.reason === 'not-displayed') {
    const settingsCopy = getSystemNotificationSettingsCopy(permissionStatus.platform)
    if (settingsCopy) {
      toast.error(settingsCopy.failureTitle, {
        description: settingsCopy.failureDescription,
        action: {
          label: translate(
            'auto.components.settings.NotificationsPane.145227ca2b',
            'Open Settings'
          ),
          onClick: () => {
            void window.api.notifications.openSystemSettings()
          }
        }
      })
    } else {
      toast.error(
        translate(
          'auto.components.settings.NotificationsPane.0cb93240b8',
          'System did not show the notification'
        ),
        {
          description: translate(
            'auto.components.settings.NotificationsPane.4676a95bc3',
            'Check your desktop notification settings for Orca.'
          )
        }
      )
    }
    return
  }

  toast.error(
    result.reason === 'disabled'
      ? translate(
          'auto.components.settings.NotificationsPane.6fc3781729',
          'Notifications are disabled'
        )
      : translate(
          'auto.components.settings.NotificationsPane.406feb0aa6',
          'Test notification was not delivered'
        )
  )
}
