import { useCallback, useMemo, useState } from 'react'
import { toast } from 'sonner'
import { Mic } from 'lucide-react'
import type { SpeechModelManifest, VoiceSettings } from '../../../../../shared/speech-types'
import { useAppStore } from '@/store'
import { useVoiceMicrophoneTest } from './use-voice-microphone-test'
import { VoiceMicrophoneTestPanel } from './VoiceMicrophoneTestPanel'
import { Button } from '../../ui/button'
import { Label } from '../../ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../../ui/select'
import {
  buildVoiceMicrophoneSelectOptions,
  microphoneDeviceIdFromSelectValue,
  resolveMicrophoneDevice
} from '@/components/dictation/microphone-devices'
import { useMountedRef } from '@/hooks/useMountedRef'
import { translate } from '@/i18n/i18n'
import { useTranslate } from '@/i18n/use-translate'
import { useUiLanguageRevision } from '@/i18n/use-ui-language-revision'
import { cn } from '@/lib/utils'
import { extractIpcErrorMessage } from '@/lib/ipc-error'
import { useVoiceMicrophoneDevices } from './use-voice-microphone-devices'

type VoiceMicrophoneSettingProps = {
  voiceSettings: VoiceSettings
  /** The selected model when it is ready, so the mic test can show what it heard. */
  readyModel?: SpeechModelManifest
  onUpdateVoiceSettings: (updates: Partial<VoiceSettings>) => void
}

function readMediaDeviceError(error: unknown): { name: string; message?: string } {
  if (!error || typeof error !== 'object') {
    return { name: '' }
  }
  // Coalesce nullable own name/message fields before String conversion so users cannot see literal undefined.
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

export function VoiceMicrophoneSetting({
  voiceSettings,
  readyModel,
  onUpdateVoiceSettings
}: VoiceMicrophoneSettingProps): React.JSX.Element {
  const t = useTranslate()
  const test = useVoiceMicrophoneTest(voiceSettings, readyModel)
  // Keeps the test's model load and microphone from competing with a live dictation.
  const dictationActive = useAppStore((s) => s.dictationState !== 'idle')
  const languageRevision = useUiLanguageRevision()
  // Rescan when dictation enables because permission and real device labels may arrive with that toggle.
  const { devices, devicesKnown, refreshDevices } = useVoiceMicrophoneDevices(voiceSettings.enabled)
  const [accessPending, setAccessPending] = useState(false)
  const [accessError, setAccessError] = useState<string | null>(null)
  const mountedRef = useMountedRef()

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
        // Strip this IPC error’s wrapper; microphone reopen never happened, so do not report an open failure.
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
        systemDefaultLabel: t(
          'auto.components.settings.VoiceMicrophoneSetting.systemDefault',
          'System default'
        ),
        unavailableSuffix: t(
          'auto.components.settings.VoiceMicrophoneSetting.unavailable',
          'unavailable'
        )
      }),
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- translate() reads the UI language implicitly.
    [
      devices,
      devicesKnown,
      voiceSettings.microphoneDeviceId,
      voiceSettings.microphoneDeviceLabel,
      languageRevision,
      t
    ]
  )

  const showAccessHint = voiceSettings.enabled && devices.length === 0
  const microphoneMissing =
    voiceSettings.enabled &&
    resolveMicrophoneDevice({
      devices: devicesKnown ? devices : null,
      preferredDeviceId: voiceSettings.microphoneDeviceId,
      preferredDeviceLabel: voiceSettings.microphoneDeviceLabel
    }).kind === 'missing'

  const testBusy = ['starting', 'recording', 'playing'].includes(test.phase.kind)

  return (
    <div data-settings-row="" className="space-y-2 py-3">
      <div className="flex items-center justify-between gap-4">
        <div className="min-w-0 flex-1 space-y-1">
          <Label>{t('components.settings.voice.input.title', 'Input')}</Label>
          <p
            className={cn(
              'text-xs',
              microphoneMissing ? 'text-status-warning-text' : 'text-muted-foreground'
            )}
          >
            {microphoneMissing
              ? t(
                  'components.settings.voice.input.missing',
                  '{{microphone}} isn’t connected. Using the system default until it’s back.',
                  {
                    microphone:
                      voiceSettings.microphoneDeviceLabel ||
                      t('components.settings.voice.setup.savedMicrophone', 'Your microphone')
                  }
                )
              : t(
                  'components.settings.voice.input.description',
                  'Follows your system setting unless you pick one.'
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
                  {t(
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
                {t('auto.components.settings.VoiceMicrophoneSetting.allowAccess', 'Allow access')}
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
            aria-label={t('auto.components.settings.VoiceMicrophoneSetting.label', 'Microphone')}
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
        <Button
          variant="outline"
          size="sm"
          className="shrink-0"
          disabled={testBusy || dictationActive}
          onClick={() => void test.start()}
        >
          <Mic />
          {t('components.settings.voice.micTest.test', 'Test')}
        </Button>
      </div>
      <VoiceMicrophoneTestPanel
        phase={test.phase}
        heard={test.heard}
        level={test.meter.level}
        modelLabel={readyModel?.label}
        microphoneError={microphoneAccessErrorMessage}
        onStop={test.stopRecording}
        onSkip={test.skipPlayback}
        onPlayAgain={test.play}
        onTestAgain={() => void test.start()}
      />
    </div>
  )
}
