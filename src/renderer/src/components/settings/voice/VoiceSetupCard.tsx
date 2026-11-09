import { CircleAlert, Check, Download, Mic } from 'lucide-react'
import type {
  SpeechModelManifest,
  SpeechModelState,
  VoiceSettings
} from '../../../../../shared/speech-types'
import { resolveMicrophoneDevice } from '@/components/dictation/microphone-devices'
import { useShortcutLabel } from '@/hooks/useShortcutLabel'
import { useTranslate } from '@/i18n/use-translate'
import { cn } from '@/lib/utils'
import { Button } from '../../ui/button'
import { Progress } from '../../ui/progress'
import { Switch } from '../../ui/switch'
import { useVoiceMicrophoneDevices } from './use-voice-microphone-devices'
import { VoiceSpeechModelQuality } from './VoiceSpeechModelQuality'
import type { SpeechModelQuality } from '../../../../../shared/speech-model-quality'

type VoiceSetupCardProps = {
  voiceSettings: VoiceSettings
  selectedModel: SpeechModelManifest | undefined
  selectedState: SpeechModelState | undefined
  permissionPending: boolean
  onToggleVoiceDictation: () => void
  onDownloadModel: (modelId: string) => void
  onCancelDownload: (modelId: string) => void
  onShowMicrophone: () => void
  /** The model one-click setup offers, with its quality for the rating language. */
  suggestion: { model: SpeechModelManifest; quality: SpeechModelQuality } | undefined
  onSetUp: () => void
}

/** The pane's first card: dictation's on/off switch and the one problem to fix, if any. */
export function VoiceSetupCard({
  voiceSettings,
  selectedModel,
  selectedState,
  permissionPending,
  onToggleVoiceDictation,
  onDownloadModel,
  onCancelDownload,
  onShowMicrophone,
  suggestion,
  onSetUp
}: VoiceSetupCardProps): React.JSX.Element {
  const t = useTranslate()
  const shortcut = useShortcutLabel('voice.dictation')
  const { devices, devicesKnown } = useVoiceMicrophoneDevices(voiceSettings.enabled)
  const microphone = resolveMicrophoneDevice({
    devices: devicesKnown ? devices : null,
    preferredDeviceId: voiceSettings.microphoneDeviceId,
    preferredDeviceLabel: voiceSettings.microphoneDeviceLabel
  })
  const downloading =
    selectedState?.status === 'downloading' || selectedState?.status === 'extracting'
  const ready = selectedState?.status === 'ready'
  const totalMb = Math.round((selectedModel?.sizeBytes ?? 0) / 1_000_000)
  const names = { model: selectedModel?.label ?? '', size: totalMb, shortcut }

  let tone: 'neutral' | 'ok' | 'warn' = 'neutral'
  let icon = <Mic />
  let title: string
  let description: string
  let body: React.ReactNode = null
  let showSwitch = true

  if (selectedModel && downloading) {
    icon = <Download />
    const percent = Math.round((selectedState?.progress ?? 0) * 100)
    title = t('speechModelUpdate.downloadingTitle', 'Downloading {{model}}', names)
    description = t(
      'components.settings.voice.setup.downloadingDescription',
      'You can leave this page. Dictation works once the download finishes.'
    )
    body = (
      <div className="flex items-center gap-3">
        <Progress value={percent} className="h-1 flex-1" />
        <span className="text-xs tabular-nums text-muted-foreground">
          {t('speechModelUpdate.progress', '{{done}} of {{total}} MB', {
            done: Math.round((selectedState?.progress ?? 0) * totalMb),
            total: totalMb
          })}
        </span>
        <Button variant="ghost" size="xs" onClick={() => onCancelDownload(selectedModel.id)}>
          {t('speechModelUpdate.cancel', 'Cancel')}
        </Button>
      </div>
    )
  } else if (selectedModel && selectedState?.needsUpdate) {
    icon = <Download />
    title = t('speechModelUpdate.updateTitle', 'Update your speech model')
    description = t(
      'speechModelUpdate.updateDescription',
      'Dictation now runs on a faster engine. {{model}} needs a one-time download ({{size}} MB) before you can dictate again.',
      names
    )
    body = (
      <div>
        <Button size="sm" onClick={() => onDownloadModel(selectedModel.id)}>
          {t('speechModelUpdate.update', 'Update')}
        </Button>
      </div>
    )
  } else if (!selectedModel || !ready) {
    title = t('components.settings.voice.setup.title', 'Set up dictation')
    if (suggestion) {
      showSwitch = voiceSettings.enabled
      description = t(
        'components.settings.voice.setup.description',
        'Talk instead of typing in any pane. Speech is recognized on this computer, so your audio stays here.'
      )
      body = (
        <div className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-1 rounded-md border border-border px-3 py-2">
            <span className="text-sm font-medium">{suggestion.model.label}</span>
            <span className="flex items-center gap-4">
              <span className="text-xs tabular-nums text-muted-foreground">
                {t('auto.components.settings.VoicePane.91980ce124', '{{value0}} MB', {
                  value0: Math.round((suggestion.model.sizeBytes ?? 0) / 1_000_000)
                })}
              </span>
              <VoiceSpeechModelQuality quality={suggestion.quality} />
            </span>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <Button size="sm" disabled={permissionPending} onClick={onSetUp}>
              <Download />
              {t('components.settings.voice.setup.setUp', 'Set up')}
            </Button>
            {voiceSettings.enabled ? null : (
              <span className="text-xs text-muted-foreground">
                {t(
                  'components.settings.voice.setup.asksForMicrophone',
                  'Orca will ask for microphone access.'
                )}
              </span>
            )}
          </div>
        </div>
      )
    } else {
      description = t(
        'components.settings.voice.setup.pickModel',
        'Talk instead of typing in any pane. Download a speech model below to start; models on this computer keep your audio here.'
      )
    }
  } else if (voiceSettings.enabled && microphone.kind === 'missing') {
    tone = 'warn'
    icon = <CircleAlert />
    title = t(
      'components.settings.voice.setup.microphoneMissingTitle',
      '{{microphone}} isn’t connected',
      {
        microphone:
          voiceSettings.microphoneDeviceLabel ||
          t('components.settings.voice.setup.savedMicrophone', 'Your microphone')
      }
    )
    description = t(
      'components.settings.voice.setup.microphoneMissingDescription',
      'Dictation uses the system default microphone until it’s back.'
    )
    body = (
      <div>
        <Button variant="outline" size="xs" onClick={onShowMicrophone}>
          {t('components.settings.voice.setup.changeMicrophone', 'Change Microphone')}
        </Button>
      </div>
    )
  } else if (voiceSettings.enabled) {
    tone = 'ok'
    icon = <Check />
    title = t('components.settings.voice.setup.onTitle', 'Dictation is on')
    description =
      selectedModel.provider === 'local'
        ? t(
            'components.settings.voice.setup.onLocal',
            'Press {{shortcut}} in any pane. {{model}} runs on this computer.',
            names
          )
        : t(
            'components.settings.voice.setup.onCloud',
            'Press {{shortcut}} in any pane. {{model}} runs in the cloud.',
            names
          )
  } else {
    title = t('components.settings.voice.setup.offTitle', 'Dictation is off')
    description = t(
      'components.settings.voice.setup.offDescription',
      'Turn it on to dictate with {{shortcut}} in any pane.',
      names
    )
  }

  return (
    <div className="flex items-start gap-3 rounded-lg border border-border bg-card p-4 shadow-xs">
      <div
        className={cn(
          'flex size-8 shrink-0 items-center justify-center rounded-md bg-muted [&_svg]:size-4',
          tone === 'ok' && 'text-status-success',
          tone === 'warn' && 'text-status-warning'
        )}
      >
        {icon}
      </div>
      <div className="min-w-0 flex-1 space-y-3">
        <div className="space-y-0.5">
          <div className="text-sm font-medium">{title}</div>
          <p className="text-xs text-muted-foreground">{description}</p>
        </div>
        {body}
      </div>
      {showSwitch ? (
        <Switch
          checked={voiceSettings.enabled}
          aria-label={t('auto.components.settings.VoicePane.0121960365', 'Enable Voice Dictation')}
          aria-busy={permissionPending}
          disabled={permissionPending}
          onCheckedChange={onToggleVoiceDictation}
          className="disabled:cursor-wait disabled:opacity-70"
        />
      ) : null}
    </div>
  )
}
