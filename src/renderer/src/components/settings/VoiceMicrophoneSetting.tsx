import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import type { VoiceSettings } from '../../../../shared/speech-types'
import { Button } from '../ui/button'
import { Label } from '../ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select'
import {
  buildVoiceMicrophoneSelectOptions,
  listVoiceMicrophoneDevices,
  microphoneDeviceIdFromSelectValue,
  type VoiceMicrophoneDevice
} from '@/components/dictation/microphone-devices'
import { useMountedRef } from '@/hooks/useMountedRef'
import { translate } from '@/i18n/i18n'
import { extractIpcErrorMessage } from '@/lib/ipc-error'

type VoiceMicrophoneSettingProps = {
  voiceSettings: VoiceSettings
  onUpdateVoiceSettings: (updates: Partial<VoiceSettings>) => void
}

function readMediaDeviceError(error: unknown): { name: string; message?: string } {
  if (!error || typeof error !== 'object') {
    return { name: '' }
  }
  // Why: an own `name`/`message` key can hold undefined/null; String() would
  // turn that into the literal "undefined" and render it to the user.
  const name = 'name' in error ? String(error.name ?? '') : ''
  const message = 'message' in error ? String(error.message ?? '').trim() || undefined : undefined
  return { name, message }
}

function isMicrophonePermissionDenied(error: unknown): boolean {
  const { name } = readMediaDeviceError(error)
  return name === 'NotAllowedError' || name === 'SecurityError'
}

function microphoneAccessErrorMessage(error: unknown): string {
  const { name, message } = readMediaDeviceError(error)
  if (name === 'NotAllowedError' || name === 'SecurityError') {
    return translate(
      'auto.components.settings.VoiceMicrophoneSetting.permissionDenied',
      'Microphone access is blocked. Grant it in your system settings, then try again.'
    )
  }
  if (name === 'NotFoundError' || name === 'DevicesNotFoundError') {
    return translate(
      'auto.components.settings.VoiceMicrophoneSetting.noMicrophoneFound',
      'No microphone was found. Connect one, then try again.'
    )
  }
  return message
    ? translate(
        'auto.components.settings.VoiceMicrophoneSetting.openFailedDetail',
        'Could not open the microphone. {{value0}}',
        { value0: message }
      )
    : translate(
        'auto.components.settings.VoiceMicrophoneSetting.openFailed',
        'Could not open the microphone.'
      )
}

function sameDeviceList(
  a: readonly VoiceMicrophoneDevice[],
  b: readonly VoiceMicrophoneDevice[]
): boolean {
  return (
    a.length === b.length &&
    a.every((device, index) => {
      const other = b[index]
      return device.deviceId === other?.deviceId && device.label === other.label
    })
  )
}

export function VoiceMicrophoneSetting({
  voiceSettings,
  onUpdateVoiceSettings
}: VoiceMicrophoneSettingProps): React.JSX.Element {
  const [devices, setDevices] = useState<VoiceMicrophoneDevice[]>([])
  const [devicesKnown, setDevicesKnown] = useState(false)
  const [accessPending, setAccessPending] = useState(false)
  const [accessError, setAccessError] = useState<string | null>(null)
  const mountedRef = useMountedRef()
  // Why: devicechange fires several times per Bluetooth connect; drop enumerations
  // that resolve out of order so a stale list cannot land last.
  const refreshGenerationRef = useRef(0)

  const refreshDevices = useCallback(async (): Promise<void> => {
    const generation = refreshGenerationRef.current + 1
    refreshGenerationRef.current = generation
    if (typeof navigator === 'undefined' || !navigator.mediaDevices?.enumerateDevices) {
      return
    }
    let next: VoiceMicrophoneDevice[] = []
    try {
      next = listVoiceMicrophoneDevices(await navigator.mediaDevices.enumerateDevices())
    } catch {
      next = []
    }
    if (!mountedRef.current || refreshGenerationRef.current !== generation) {
      return
    }
    setDevicesKnown(next.length > 0)
    setDevices((current) => (sameDeviceList(current, next) ? current : next))
  }, [mountedRef])

  // Why: voiceSettings.enabled is a dependency so enabling dictation re-scans —
  // that toggle is often when mic permission lands and real labels appear.
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

  // A generic stream grants discovery even when the saved device is stale.
  const openStreamAndRefreshDevices = useCallback(async (): Promise<void> => {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
    stream.getTracks().forEach((track) => track.stop())
    await refreshDevices()
  }, [refreshDevices])

  const requestMicrophoneAccess = useCallback(async (): Promise<void> => {
    if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
      return
    }
    setAccessPending(true)
    setAccessError(null)
    try {
      try {
        await openStreamAndRefreshDevices()
        return
      } catch (error) {
        if (!isMicrophonePermissionDenied(error)) {
          throw error
        }
      }

      let result: Awaited<ReturnType<typeof window.api.developerPermissions.request>>
      try {
        result = await window.api.developerPermissions.request({ id: 'microphone' })
      } catch (error) {
        // Why separate: this one DID cross IPC, so the wrapper must be stripped — and the microphone
        // was never reopened, so reporting it as an open failure would invert the provenance.
        if (mountedRef.current) {
          setAccessError(
            extractIpcErrorMessage(
              error,
              translate(
                'auto.components.settings.VoicePane.ad5d036ecc',
                'Could not request microphone permission. Voice dictation was not enabled.'
              )
            )
          )
        }
        return
      }
      if (!mountedRef.current) {
        return
      }
      if (result.status !== 'granted') {
        setAccessError(
          result.openedSystemSettings
            ? translate(
                'auto.components.settings.VoiceMicrophoneSetting.openedSystemSettings',
                'Opened macOS Privacy & Security. Grant microphone access, then try again.'
              )
            : translate(
                'auto.components.settings.VoiceMicrophoneSetting.permissionDenied',
                'Microphone access is blocked. Grant it in your system settings, then try again.'
              )
        )
        return
      }
      await openStreamAndRefreshDevices()
      if (mountedRef.current) {
        toast.success(
          translate(
            'auto.components.settings.VoicePane.cd9fe37556',
            'Microphone permission granted'
          )
        )
      }
    } catch (error) {
      if (mountedRef.current) {
        setAccessError(microphoneAccessErrorMessage(error))
      }
    } finally {
      if (mountedRef.current) {
        setAccessPending(false)
      }
    }
  }, [mountedRef, openStreamAndRefreshDevices])

  const { options, selectedValue } = useMemo(
    () =>
      buildVoiceMicrophoneSelectOptions({
        devices,
        devicesKnown,
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
      }),
    [devices, devicesKnown, voiceSettings.microphoneDeviceId, voiceSettings.microphoneDeviceLabel]
  )

  const showAccessHint = voiceSettings.enabled && devices.length === 0

  return (
    <div className="flex items-center justify-between gap-4 py-2">
      <div className="min-w-0 space-y-0.5">
        <Label>
          {translate('auto.components.settings.VoiceMicrophoneSetting.label', 'Microphone')}
        </Label>
        <p className="text-xs text-muted-foreground">
          {translate(
            'auto.components.settings.VoiceMicrophoneSetting.description',
            'Input device used for voice dictation. System default follows the OS microphone setting.'
          )}
        </p>
        {showAccessHint && (
          <div className="flex flex-wrap items-center gap-2 pt-1">
            {accessError ? (
              <p className="text-xs text-destructive" role="alert">
                {accessError}
              </p>
            ) : (
              <p className="text-xs text-muted-foreground">
                {translate(
                  'auto.components.settings.VoiceMicrophoneSetting.accessHint',
                  'Allow microphone access to list input devices.'
                )}
              </p>
            )}
            <Button
              variant="outline"
              size="sm"
              className="h-6 px-2 text-xs"
              disabled={accessPending}
              onClick={() => void requestMicrophoneAccess()}
            >
              {translate(
                'auto.components.settings.VoiceMicrophoneSetting.allowAccess',
                'Allow access'
              )}
            </Button>
          </div>
        )}
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
          className={`h-7 w-52 shrink-0 text-xs ${!voiceSettings.enabled ? 'opacity-50' : ''}`}
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
