import { useState } from 'react'
import { toast } from 'sonner'
import type { GlobalSettings } from '../../../../shared/types'
import { Label } from '../ui/label'
import { Slider } from '../ui/slider'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectSeparator,
  SelectTrigger,
  SelectValue
} from '../ui/select'
import { FileAudio, Upload, Volume2 } from 'lucide-react'
import { getNotificationSoundOptions } from '@/components/notification-sound-options'
import { useMountedRef } from '@/hooks/useMountedRef'
import { translate } from '@/i18n/i18n'

const CHOOSE_CUSTOM_SOUND_VALUE = 'choose-custom-file'

type NotificationSoundSelectValue =
  | GlobalSettings['notifications']['customSoundId']
  | typeof CHOOSE_CUSTOM_SOUND_VALUE

function isNotificationSoundId(
  value: NotificationSoundSelectValue
): value is GlobalSettings['notifications']['customSoundId'] {
  return value !== CHOOSE_CUSTOM_SOUND_VALUE
}

type NotificationSoundSectionProps = {
  notificationSettings: GlobalSettings['notifications']
  notificationsEnabled: boolean
  volumeDraft: number
  onVolumeDraftChange: (value: number) => void
  onVolumeCommit: (value: number) => void
  onUpdateNotificationSettings: (updates: Partial<GlobalSettings['notifications']>) => Promise<void>
}

export function NotificationSoundSection({
  notificationSettings,
  notificationsEnabled,
  volumeDraft,
  onVolumeDraftChange,
  onVolumeCommit,
  onUpdateNotificationSettings
}: NotificationSoundSectionProps): React.JSX.Element {
  const mountedRef = useMountedRef()
  const [isPickingSound, setIsPickingSound] = useState(false)

  const previewSound = async (
    customSoundId: GlobalSettings['notifications']['customSoundId']
  ): Promise<void> => {
    if (customSoundId === 'system') {
      return
    }
    const result = await window.api.notifications.playSound({
      force: true,
      volume: volumeDraft
    })
    if (!result.played) {
      toast.error(
        translate(
          'auto.components.settings.NotificationsPane.0fadad17ce',
          'Notification sound could not be played'
        )
      )
    }
  }

  const handleChooseCustomSound = async (): Promise<void> => {
    setIsPickingSound(true)
    try {
      const soundPath = await window.api.shell.pickAudio()
      if (soundPath) {
        await onUpdateNotificationSettings({ customSoundId: 'custom', customSoundPath: soundPath })
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
    await onUpdateNotificationSettings({ customSoundId: value })
    await previewSound(value)
  }

  const selectedSoundId = notificationSettings.customSoundId
  const soundOptions = getNotificationSoundOptions(notificationSettings.customSoundPath)

  return (
    <div className="space-y-2 py-2">
      <div className="space-y-0.5">
        <div className="flex items-center gap-2">
          <FileAudio className="size-4" />
          <Label>
            {translate(
              'auto.components.settings.NotificationsPane.88686e6ca8',
              'Notification Sound'
            )}
          </Label>
        </div>
        <p className="text-xs text-muted-foreground">
          {translate(
            'auto.components.settings.NotificationsPane.2a2033c388',
            'Choose the alert Orca plays when a desktop notification is delivered.'
          )}
        </p>
      </div>
      <Select
        value={selectedSoundId}
        disabled={!notificationsEnabled || isPickingSound}
        onValueChange={(value) => void handleSoundSelect(value as NotificationSoundSelectValue)}
      >
        <SelectTrigger className="w-full max-w-[360px]" size="sm">
          <SelectValue
            placeholder={translate(
              'auto.components.settings.NotificationsPane.c258cb96dc',
              'Choose notification sound'
            )}
          />
        </SelectTrigger>
        <SelectContent align="start" className="w-[--radix-select-trigger-width]">
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
            <span>
              {notificationSettings.customSoundPath
                ? translate(
                    'auto.components.settings.NotificationsPane.76e02467b8',
                    'Change Custom File'
                  )
                : translate(
                    'auto.components.settings.NotificationsPane.6e6df3a09a',
                    'Choose Custom File'
                  )}
            </span>
          </SelectItem>
        </SelectContent>
      </Select>
      {notificationSettings.customSoundPath ? (
        <p
          className="truncate font-mono text-[11px] text-muted-foreground"
          title={notificationSettings.customSoundPath}
        >
          {translate('auto.components.settings.NotificationsPane.4aa5085cd7', 'Custom:')}
          {notificationSettings.customSoundPath}
        </p>
      ) : null}
      {selectedSoundId !== 'system' ? (
        <div className="flex items-center gap-3 pt-1">
          <Volume2 className="size-4 text-muted-foreground" />
          <Slider
            value={[volumeDraft]}
            min={0}
            max={100}
            step={5}
            disabled={!notificationsEnabled}
            onValueChange={([value]) => onVolumeDraftChange(value)}
            onValueCommit={([value]) => onVolumeCommit(value)}
            className="flex-1"
            aria-label={translate(
              'auto.components.settings.NotificationsPane.2a42dd8d6f',
              'Notification sound volume'
            )}
          />
          <span className="w-10 text-right font-mono text-xs tabular-nums text-muted-foreground">
            {volumeDraft}%
          </span>
        </div>
      ) : null}
    </div>
  )
}
