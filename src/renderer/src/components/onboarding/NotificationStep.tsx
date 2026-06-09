/* eslint-disable max-lines -- Why: this onboarding step owns the full notification setup surface, including macOS guidance, sound choices, and upload controls. */
import { useCallback, useEffect, useRef, useState } from 'react'
import { BellRing, FileAudio, Settings, Upload } from 'lucide-react'
import { toast } from 'sonner'
import type { GlobalSettings, NotificationPermissionStatusResult } from '../../../../shared/types'
import { Button } from '@/components/ui/button'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectSeparator,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { sendNotificationSettingsTestNotification } from '@/components/settings/NotificationsPane'
import { getNotificationSoundOptions } from '@/components/notification-sound-options'
import { useMountedRef } from '@/hooks/useMountedRef'
import { translate } from '@/i18n/i18n'

export type NotificationDraft = {
  agentTaskComplete: boolean
  terminalBell: boolean
  notifyWhenFocused: boolean
}

type NotificationStepProps = {
  settings: GlobalSettings | null
  updateSettings: (updates: Partial<GlobalSettings>) => Promise<void> | void
}

const CHOOSE_CUSTOM_SOUND_VALUE = 'choose-custom-file'

type NotificationSoundSelectValue =
  | GlobalSettings['notifications']['customSoundId']
  | typeof CHOOSE_CUSTOM_SOUND_VALUE

function isNotificationSoundId(
  value: NotificationSoundSelectValue
): value is GlobalSettings['notifications']['customSoundId'] {
  return value !== CHOOSE_CUSTOM_SOUND_VALUE
}

export function NotificationStep({
  settings,
  updateSettings
}: NotificationStepProps): React.JSX.Element {
  const notificationSettings = settings?.notifications
  const notificationSettingsRef = useRef(notificationSettings)
  const [permissionStatus, setPermissionStatus] =
    useState<NotificationPermissionStatusResult | null>(null)
  const [isPickingSound, setIsPickingSound] = useState(false)
  const [selectPortalRoot, setSelectPortalRoot] = useState<HTMLElement | null>(null)
  const syncedNotificationSettingsRef = useRef(notificationSettings)
  const mountedRef = useMountedRef()

  if (syncedNotificationSettingsRef.current !== notificationSettings) {
    syncedNotificationSettingsRef.current = notificationSettings
    // Why: handlers optimistically update the ref before persisted settings
    // flow back through props, so local re-renders must not overwrite it.
    notificationSettingsRef.current = notificationSettings
  }

  const setSelectPortalHost = useCallback((node: HTMLDivElement | null) => {
    // Why: onboarding sits above body-level portals, so the select menu must
    // portal into the overlay to stay clickable.
    setSelectPortalRoot(node?.closest<HTMLElement>('[data-onboarding-overlay]') ?? node)
  }, [])

  useEffect(() => {
    let cancelled = false
    void window.api.notifications.getPermissionStatus().then((status) => {
      if (!cancelled) {
        setPermissionStatus(status)
      }
    })
    return () => {
      cancelled = true
    }
  }, [])

  const updateNotificationSettings = async (
    updates: Partial<GlobalSettings['notifications']>
  ): Promise<void> => {
    const current = notificationSettingsRef.current
    if (!current) {
      return
    }
    const nextNotifications = {
      ...current,
      ...updates
    }
    notificationSettingsRef.current = nextNotifications
    await updateSettings({
      notifications: nextNotifications
    })
  }

  const getCustomSoundVolume = (): number =>
    notificationSettingsRef.current?.customSoundVolume ?? 100

  const handleMacPermission = async (): Promise<void> => {
    const status = await window.api.notifications.requestPermission()
    if (mountedRef.current) {
      setPermissionStatus(status)
    }
    await window.api.notifications.openSystemSettings()
  }

  const previewSound = async (
    customSoundId: GlobalSettings['notifications']['customSoundId']
  ): Promise<void> => {
    if (customSoundId === 'system') {
      return
    }
    const result = await window.api.notifications.playSound({
      force: true,
      volume: getCustomSoundVolume()
    })
    if (!result.played) {
      if (mountedRef.current) {
        toast.error(translate("auto.components.onboarding.NotificationStep.b6a994e36e", "Notification sound could not be played"))
      }
    }
  }

  const handleChooseCustomSound = async (): Promise<void> => {
    setIsPickingSound(true)
    try {
      const soundPath = await window.api.shell.pickAudio()
      if (soundPath) {
        await updateNotificationSettings({ customSoundId: 'custom', customSoundPath: soundPath })
        await previewSound('custom')
      }
    } finally {
      if (mountedRef.current) {
        setIsPickingSound(false)
      }
    }
  }

  const handleSoundSelect = async (value: NotificationSoundSelectValue): Promise<void> => {
    if (!isNotificationSoundId(value)) {
      await handleChooseCustomSound()
      return
    }
    await updateNotificationSettings({ customSoundId: value })
    await previewSound(value)
  }

  const handleSendTestNotification = async (): Promise<void> => {
    if (!notificationSettings) {
      toast.error(translate("auto.components.onboarding.NotificationStep.3cd5374e22", "Notification settings are still loading"))
      return
    }
    await sendNotificationSettingsTestNotification(notificationSettings, getCustomSoundVolume())
  }

  if (!notificationSettings) {
    return (
      <div className="rounded-xl border border-border bg-muted/20 px-5 py-4 text-sm text-muted-foreground">
        {translate("auto.components.onboarding.NotificationStep.e52aacf380", "Loading notification settings…")}</div>
    )
  }

  const customPath = notificationSettings.customSoundPath
  const selectedSoundId = notificationSettings.customSoundId
  const soundOptions = getNotificationSoundOptions(customPath)
  const isMac = permissionStatus?.platform === 'darwin'

  return (
    <div ref={setSelectPortalHost} className="space-y-5">
      {isMac ? (
        <section className="rounded-xl border border-border bg-card px-5 py-4">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="min-w-0 space-y-1">
              <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
                <Settings className="size-4" />
                {translate("auto.components.onboarding.NotificationStep.d2dba86837", "Allow Orca in macOS")}</div>
              <p className="max-w-[58ch] text-[13px] leading-relaxed text-muted-foreground">
                {translate("auto.components.onboarding.NotificationStep.aa36281b00", "Open System Settings and make sure Orca is allowed to send notifications.")}</p>
            </div>
            <Button
              type="button"
              size="sm"
              className="gap-2"
              onClick={() => void handleMacPermission()}
            >
              <Settings className="size-3.5" />
              {translate("auto.components.onboarding.NotificationStep.8124d085a6", "Open Mac Settings")}</Button>
          </div>
        </section>
      ) : null}

      <section className="space-y-3">
        <div className="space-y-1">
          <h2 className="text-sm font-semibold text-foreground">{translate("auto.components.onboarding.NotificationStep.0af746e41f", "Choose a sound")}</h2>
          <p className="text-[13px] leading-relaxed text-muted-foreground">
            {translate("auto.components.onboarding.NotificationStep.0fe570690c", "Pick the alert Orca plays after a desktop notification is delivered.")}</p>
        </div>

        <div className="space-y-2">
          <div className="flex items-center gap-2 text-sm font-medium text-foreground">
            <FileAudio className="size-4" />
            {translate("auto.components.onboarding.NotificationStep.53aaffe49a", "Notification Sound")}</div>
          <div className="flex flex-wrap items-center gap-2">
            <Select
              value={selectedSoundId}
              disabled={isPickingSound}
              onValueChange={(value) =>
                void handleSoundSelect(value as NotificationSoundSelectValue)
              }
            >
              <SelectTrigger className="w-[360px] max-w-full" size="sm">
                <SelectValue placeholder={translate("auto.components.onboarding.NotificationStep.dc897423e1", "Choose notification sound")} />
              </SelectTrigger>
              <SelectContent
                portalContainer={selectPortalRoot}
                align="start"
                className="w-[--radix-select-trigger-width]"
              >
                {soundOptions.map((option) => {
                  const OptionIcon = option.icon
                  return (
                    <SelectItem key={option.id} value={option.id}>
                      <OptionIcon className="size-4" />
                      <span className="truncate">{option.title}</span>
                    </SelectItem>
                  )
                })}
                <SelectSeparator />
                <SelectItem value={CHOOSE_CUSTOM_SOUND_VALUE}>
                  <Upload className="size-4" />
                  <span>{customPath ? translate("auto.components.onboarding.NotificationStep.ac80d97e02", "Change Custom File") : translate("auto.components.onboarding.NotificationStep.c0692baa52", "Choose Custom File")}</span>
                </SelectItem>
              </SelectContent>
            </Select>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="gap-2"
              onClick={() => void handleSendTestNotification()}
            >
              <BellRing className="size-3.5" />
              {translate("auto.components.onboarding.NotificationStep.3bede04483", "Send Test Notification")}</Button>
          </div>
        </div>
      </section>
    </div>
  )
}
