import { useCallback, useEffect, useState } from 'react'
import type { VoiceSettings } from '../../../../shared/speech-types'
import { Label } from '../ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select'
import {
  buildVoiceMicrophoneSelectOptions,
  listVoiceMicrophoneDevices,
  microphoneDeviceIdFromSelectValue,
  microphoneSelectValueFromDeviceId,
  type VoiceMicrophoneDevice
} from '@/hooks/voice-microphone-devices'
import { translate } from '@/i18n/i18n'

type VoiceMicrophoneSettingProps = {
  voiceSettings: VoiceSettings
  onUpdateVoiceSettings: (updates: Partial<VoiceSettings>) => void
}

export function VoiceMicrophoneSetting({
  voiceSettings,
  onUpdateVoiceSettings
}: VoiceMicrophoneSettingProps): React.JSX.Element {
  const [devices, setDevices] = useState<VoiceMicrophoneDevice[]>([])

  const refreshDevices = useCallback(async (): Promise<void> => {
    if (typeof navigator === 'undefined' || !navigator.mediaDevices?.enumerateDevices) {
      setDevices([])
      return
    }
    try {
      const next = listVoiceMicrophoneDevices(await navigator.mediaDevices.enumerateDevices())
      setDevices(next)
    } catch {
      setDevices([])
    }
  }, [])

  useEffect(() => {
    void refreshDevices()
    if (typeof navigator === 'undefined' || !navigator.mediaDevices?.addEventListener) {
      return
    }
    const handleDeviceChange = (): void => {
      void refreshDevices()
    }
    navigator.mediaDevices.addEventListener('devicechange', handleDeviceChange)
    return () => {
      navigator.mediaDevices.removeEventListener('devicechange', handleDeviceChange)
    }
  }, [refreshDevices, voiceSettings.enabled])

  const options = buildVoiceMicrophoneSelectOptions({
    devices,
    preferredDeviceId: voiceSettings.microphoneDeviceId,
    preferredDeviceLabel: voiceSettings.microphoneDeviceLabel,
    systemDefaultLabel: translate(
      'auto.components.settings.VoiceMicrophoneSetting.systemDefault',
      'System default'
    ),
    unavailableSuffix: translate(
      'auto.components.settings.VoiceMicrophoneSetting.unavailable',
      'unavailable'
    )
  })

  const selectedValue = microphoneSelectValueFromDeviceId(voiceSettings.microphoneDeviceId)

  return (
    <div className="flex items-center justify-between gap-4 py-2">
      <div className="space-y-0.5">
        <Label>
          {translate('auto.components.settings.VoiceMicrophoneSetting.label', 'Microphone')}
        </Label>
        <p className="text-xs text-muted-foreground">
          {translate(
            'auto.components.settings.VoiceMicrophoneSetting.description',
            'Input device used for voice dictation. System default follows the OS microphone setting.'
          )}
        </p>
      </div>
      <Select
        value={selectedValue}
        disabled={!voiceSettings.enabled}
        onOpenChange={(open) => {
          if (open) {
            void refreshDevices()
          }
        }}
        onValueChange={(value) => {
          const deviceId = microphoneDeviceIdFromSelectValue(value)
          if (!deviceId) {
            onUpdateVoiceSettings({
              microphoneDeviceId: null,
              microphoneDeviceLabel: null
            })
            return
          }
          const match = devices.find((device) => device.deviceId === deviceId)
          onUpdateVoiceSettings({
            microphoneDeviceId: deviceId,
            microphoneDeviceLabel: match?.label ?? voiceSettings.microphoneDeviceLabel
          })
        }}
      >
        <SelectTrigger
          className={`h-7 w-52 text-xs ${!voiceSettings.enabled ? 'opacity-50' : ''}`}
          aria-label={translate(
            'auto.components.settings.VoiceMicrophoneSetting.label',
            'Microphone'
          )}
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {options.map((option) => (
            <SelectItem key={option.value} value={option.value} className="text-xs">
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  )
}
