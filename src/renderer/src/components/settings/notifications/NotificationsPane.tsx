import { useEffect, useRef, useState } from 'react'
import type { GlobalSettings } from '../../../../../shared/global-settings-types'
import { Button } from '../../ui/button'
import { Separator } from '../../ui/separator'
import { BellRing, Bot, EyeOff, MessageCircleQuestion, Siren } from 'lucide-react'
import { useAppStore } from '@/store/index'
import {
  MacNotificationPermissionCard,
  useMacNotificationPermissionState
} from '@/components/notifications/mac-notification-permission-card'
import { NotificationSettingToggle } from './NotificationSettingToggle'
import { NotificationHostToggles } from './NotificationHostToggles'
import { NotificationSoundSection } from './NotificationSoundSection'
import { sendNotificationSettingsTestNotification } from '@/components/notifications/notification-test-delivery'
import { useTranslate } from '@/i18n/use-translate'

type NotificationVolumeDraftState = {
  sourceVolume: number
  draft: number
}

function createNotificationVolumeDraftState(sourceVolume: number): NotificationVolumeDraftState {
  return {
    sourceVolume,
    draft: sourceVolume
  }
}

function resolveNotificationVolumeDraftState(
  state: NotificationVolumeDraftState,
  sourceVolume: number
): NotificationVolumeDraftState {
  return state.sourceVolume === sourceVolume
    ? state
    : createNotificationVolumeDraftState(sourceVolume)
}

type NotificationsPaneProps = {
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => void | Promise<void>
}

/** Merge rapid edits against the latest settings; question-only mode preserves disabled source toggles for later use. */
export function NotificationsPane({
  settings,
  updateSettings
}: NotificationsPaneProps): React.JSX.Element {
  const t = useTranslate()
  const notificationSettings = settings.notifications
  const notificationSettingsRef = useRef(notificationSettings)
  const [macPermissionState, setMacPermissionState] = useMacNotificationPermissionState(
    notificationSettings.enabled
  )

  const updateNotificationSettings = async (
    updates: Partial<GlobalSettings['notifications']>
  ): Promise<void> => {
    const nextNotifications = {
      ...notificationSettingsRef.current,
      ...updates
    }
    notificationSettingsRef.current = nextNotifications
    await updateSettings({
      notifications: {
        ...nextNotifications
      }
    })
  }

  useEffect(() => {
    notificationSettingsRef.current = notificationSettings
  }, [notificationSettings])

  const [volumeDraftState, setVolumeDraftState] = useState(() =>
    createNotificationVolumeDraftState(notificationSettings.customSoundVolume)
  )
  const resolvedVolumeDraftState = resolveNotificationVolumeDraftState(
    volumeDraftState,
    notificationSettings.customSoundVolume
  )
  if (resolvedVolumeDraftState !== volumeDraftState) {
    setVolumeDraftState(resolvedVolumeDraftState)
  }
  const volumeDraft = resolvedVolumeDraftState.draft
  const setVolumeDraft = (value: number): void => {
    setVolumeDraftState((current) => ({
      ...resolveNotificationVolumeDraftState(current, notificationSettings.customSoundVolume),
      draft: value
    }))
  }

  const handleVolumeCommit = (value: number): void => {
    if (notificationSettingsRef.current.customSoundVolume !== value) {
      void updateNotificationSettings({ customSoundVolume: value })
    }
  }

  const handleSendTestNotification = async (): Promise<void> => {
    useAppStore.getState().recordFeatureInteraction('notifications')
    const showsMacPermissionCard = macPermissionState !== null
    const outcome = await sendNotificationSettingsTestNotification(
      notificationSettings,
      volumeDraft,
      // Inline delivery state replaces ambiguous macOS banner-check toasts.
      showsMacPermissionCard ? { suppressSystemPermissionToasts: true } : undefined
    )
    if (!showsMacPermissionCard) {
      return
    }
    if (outcome === 'delivered') {
      setMacPermissionState('enabled')
    } else if (outcome === 'not-displayed') {
      setMacPermissionState('blocked')
    }
  }

  return (
    <div className="space-y-1">
      {macPermissionState !== null ? (
        <div className="pb-3">
          <MacNotificationPermissionCard state={macPermissionState} />
        </div>
      ) : null}
      <NotificationSettingToggle
        label={t('auto.components.settings.NotificationsPane.9c41a0d367', 'Enable notifications')}
        description={t(
          'auto.components.settings.NotificationsPane.deff6d30da',
          'Native system notifications for background events.'
        )}
        checked={notificationSettings.enabled}
        onToggle={() => {
          if (!notificationSettings.enabled) {
            useAppStore.getState().recordFeatureInteraction('notifications')
          }
          void updateNotificationSettings({ enabled: !notificationSettings.enabled })
        }}
      />

      <Separator />

      <NotificationSettingToggle
        icon={<MessageCircleQuestion className="size-4" />}
        label={t('notifications.questionsOnly', 'Questions Only')}
        description={t(
          'notifications.questionsOnlyDescription',
          'Only notify when an agent asks a question. Mute permission requests, completed tasks, and terminal bells.'
        )}
        checked={notificationSettings.agentQuestionsOnly === true}
        disabled={!notificationSettings.enabled}
        onToggle={() =>
          void updateNotificationSettings({
            agentQuestionsOnly: !notificationSettings.agentQuestionsOnly
          })
        }
      />

      <NotificationSettingToggle
        icon={<Bot className="size-4" />}
        label={t('auto.components.settings.NotificationsPane.0acae1066d', 'Agent task complete')}
        description={t(
          'auto.components.settings.NotificationsPane.55f901a59b',
          'A coding agent finishes and becomes idle.'
        )}
        checked={notificationSettings.agentTaskComplete}
        disabled={!notificationSettings.enabled || notificationSettings.agentQuestionsOnly}
        onToggle={() =>
          void updateNotificationSettings({
            agentTaskComplete: !notificationSettings.agentTaskComplete
          })
        }
      />

      <NotificationSettingToggle
        icon={<MessageCircleQuestion className="size-4" />}
        label={t('auto.components.settings.NotificationsPane.05f5c5ab50', 'Agent needs input')}
        description={t(
          'auto.components.settings.NotificationsPane.e1b1724793',
          'A coding agent asks for permission or has a question.'
        )}
        checked={notificationSettings.agentNeedsInput}
        disabled={!notificationSettings.enabled || notificationSettings.agentQuestionsOnly}
        onToggle={() =>
          void updateNotificationSettings({
            agentNeedsInput: !notificationSettings.agentNeedsInput
          })
        }
      />

      <NotificationSettingToggle
        icon={<Siren className="size-4" />}
        label={t('auto.components.settings.NotificationsPane.6bc7bd7b6e', 'Terminal bell')}
        description={t(
          'auto.components.settings.NotificationsPane.b6fc369244',
          'A background terminal emits a bell character.'
        )}
        checked={notificationSettings.terminalBell}
        disabled={!notificationSettings.enabled || notificationSettings.agentQuestionsOnly}
        onToggle={() =>
          void updateNotificationSettings({
            terminalBell: !notificationSettings.terminalBell
          })
        }
      />

      <NotificationHostToggles
        mutedNotificationSourceIds={notificationSettings.mutedNotificationSourceIds}
        disabled={!notificationSettings.enabled}
        onChange={(hostIds, muted) =>
          void updateNotificationSettings({
            mutedNotificationSourceIds: muted
              ? [
                  ...new Set([
                    ...notificationSettingsRef.current.mutedNotificationSourceIds,
                    ...hostIds
                  ])
                ]
              : notificationSettingsRef.current.mutedNotificationSourceIds.filter(
                  (id) => !hostIds.includes(id)
                )
          })
        }
      />

      <NotificationSettingToggle
        icon={<EyeOff className="size-4" />}
        label={t(
          'auto.components.settings.NotificationsPane.3b77513cd0',
          'Notify about hidden workspaces'
        )}
        description={t(
          'auto.components.settings.NotificationsPane.e4b5e909ff',
          "When off, workspaces hidden by a Hide switch in the sidebar's Filters menu show no unread dot and send no notifications to this computer or your phone."
        )}
        checked={notificationSettings.notifyHiddenWorkspaces}
        onToggle={() =>
          void updateNotificationSettings({
            notifyHiddenWorkspaces: !notificationSettings.notifyHiddenWorkspaces
          })
        }
      />

      <Separator />

      <NotificationSoundSection
        notificationSettings={notificationSettings}
        notificationsEnabled={notificationSettings.enabled}
        volumeDraft={volumeDraft}
        onVolumeDraftChange={setVolumeDraft}
        onVolumeCommit={handleVolumeCommit}
        onUpdateNotificationSettings={updateNotificationSettings}
      />

      <Separator />

      <NotificationSettingToggle
        label={t('auto.components.settings.NotificationsPane.badd7ed4cf', 'Suppress while focused')}
        description={t(
          'auto.components.settings.NotificationsPane.2772d2f257',
          'Skip notifications when the triggering worktree is already visible.'
        )}
        checked={notificationSettings.suppressWhenFocused}
        disabled={!notificationSettings.enabled}
        onToggle={() =>
          void updateNotificationSettings({
            suppressWhenFocused: !notificationSettings.suppressWhenFocused
          })
        }
      />

      <div className="flex flex-wrap items-center gap-2 pt-3">
        <Button
          variant="outline"
          size="sm"
          disabled={!notificationSettings.enabled}
          onClick={() => void handleSendTestNotification()}
          className="gap-2"
        >
          <BellRing className="size-3.5" />
          {t('auto.components.settings.NotificationsPane.f5b0498e1f', 'Send test notification')}
        </Button>
      </div>
    </div>
  )
}
