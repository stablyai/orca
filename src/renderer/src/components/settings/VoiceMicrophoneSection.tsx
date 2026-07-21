import { useEffect, useState } from 'react'
import type { VoiceSettings } from '../../../../shared/speech-types'
import { Label } from '../ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select'
import { translate } from '@/i18n/i18n'

const SYSTEM_DEVICE_VALUE = '__system__'

type AudioInputDevice = {
  deviceId: string
  label: string
  unavailable?: boolean
}

export function getMicrophoneDeviceLabel(args: { label: string; index: number }): string {
  return args.label || `Microphone ${args.index + 1}`
}

export function getMicrophoneSelectDevices(
  devices: AudioInputDevice[],
  selectedInputDeviceId: string
): AudioInputDevice[] {
  if (
    !selectedInputDeviceId ||
    devices.some((device) => device.deviceId === selectedInputDeviceId)
  ) {
    return devices
  }
  return [
    {
      deviceId: selectedInputDeviceId,
      label: 'Unavailable microphone',
      unavailable: true
    },
    ...devices
  ]
}

type VoiceMicrophoneSectionProps = {
  voiceSettings: VoiceSettings
  onUpdateVoiceSettings: (updates: Partial<VoiceSettings>) => void
}

export function VoiceMicrophoneSection({
  voiceSettings,
  onUpdateVoiceSettings
}: VoiceMicrophoneSectionProps): React.JSX.Element {
  const [devices, setDevices] = useState<AudioInputDevice[]>([])
  const [enumerationFailed, setEnumerationFailed] = useState(false)

  useEffect(() => {
    let cancelled = false
    const refreshDevices = async (): Promise<void> => {
      if (!navigator.mediaDevices?.enumerateDevices) {
        setEnumerationFailed(true)
        return
      }
      try {
        const allDevices = await navigator.mediaDevices.enumerateDevices()
        if (cancelled) {
          return
        }
        const audioInputs = allDevices
          .filter((device) => device.kind === 'audioinput')
          .map((device, index) => ({
            deviceId: device.deviceId,
            label: getMicrophoneDeviceLabel({ label: device.label, index })
          }))
        setDevices(audioInputs)
        setEnumerationFailed(false)
      } catch {
        if (!cancelled) {
          setEnumerationFailed(true)
        }
      }
    }

    void refreshDevices()
    navigator.mediaDevices?.addEventListener?.('devicechange', refreshDevices)
    return () => {
      cancelled = true
      navigator.mediaDevices?.removeEventListener?.('devicechange', refreshDevices)
    }
  }, [])

  const selectedValue = voiceSettings.inputDeviceId || SYSTEM_DEVICE_VALUE
  const selectDevices = getMicrophoneSelectDevices(devices, voiceSettings.inputDeviceId)

  return (
    <div className="flex items-center justify-between gap-4 py-2">
      <div className="space-y-0.5">
        <Label>
          {translate('auto.components.settings.VoicePane.microphone.label', 'Microphone')}
        </Label>
        <p className="max-w-[34rem] text-xs text-muted-foreground">
          {enumerationFailed
            ? translate(
                'auto.components.settings.VoicePane.microphone.unavailable',
                'Could not list microphones. Orca will use the system default.'
              )
            : translate(
                'auto.components.settings.VoicePane.microphone.description',
                'Choose the input device Orca uses for voice dictation.'
              )}
        </p>
      </div>
      <Select
        value={selectedValue}
        onValueChange={(value) =>
          onUpdateVoiceSettings({
            inputDeviceId: value === SYSTEM_DEVICE_VALUE ? '' : value
          })
        }
      >
        <SelectTrigger className="w-64">
          <SelectValue
            placeholder={translate(
              'auto.components.settings.VoicePane.microphone.systemDefault',
              'System Default'
            )}
          />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={SYSTEM_DEVICE_VALUE}>
            {translate(
              'auto.components.settings.VoicePane.microphone.systemDefault',
              'System Default'
            )}
          </SelectItem>
          {selectDevices.map((device) => (
            <SelectItem key={device.deviceId} value={device.deviceId}>
              {device.unavailable
                ? translate(
                    'auto.components.settings.VoicePane.microphone.unavailableDevice',
                    'Unavailable microphone'
                  )
                : device.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  )
}
