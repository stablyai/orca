import type { VoiceSettings, DictationOutputVolumeMode } from '../../../../shared/speech-types'
import type { DictationOutputCapabilities } from '../../../../shared/dictation-output-settings'
import {
  clampDuckedVolumePercent,
  normalizeDictationOutputVolumeMode
} from '../../../../shared/dictation-output-settings'
import { Label } from '../ui/label'
import { Separator } from '../ui/separator'
import { Slider } from '../ui/slider'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select'
import { translate } from '@/i18n/i18n'

type VoiceAudioOutputSectionProps = {
  voiceSettings: VoiceSettings
  capabilities: DictationOutputCapabilities
  onUpdateVoiceSettings: (updates: Partial<VoiceSettings>) => void
}

type VoiceAudioOutputSectionComponent = {
  (props: VoiceAudioOutputSectionProps): React.JSX.Element
  applyDuckedVolumeUpdate: (
    onUpdateVoiceSettings: (updates: Partial<VoiceSettings>) => void,
    value: number
  ) => void
  applyOutputVolumeModeUpdate: (
    onUpdateVoiceSettings: (updates: Partial<VoiceSettings>) => void,
    mode: unknown
  ) => void
}

const OUTPUT_MODES: { mode: DictationOutputVolumeMode; label: string }[] = [
  { mode: 'unchanged', label: 'Unchanged' },
  { mode: 'mute', label: 'Muted' },
  { mode: 'duck', label: 'Lowered' }
]

function canUseOutputMode(
  mode: DictationOutputVolumeMode,
  capabilities: DictationOutputCapabilities
): boolean {
  if (mode === 'mute') {
    return capabilities.canMuteOutput
  }
  if (mode === 'duck') {
    return capabilities.canDuckOutput
  }
  return true
}

function applyDuckedVolumeUpdate(
  onUpdateVoiceSettings: (updates: Partial<VoiceSettings>) => void,
  value: number
): void {
  onUpdateVoiceSettings({ duckedVolumePercent: clampDuckedVolumePercent(value) })
}

function applyOutputVolumeModeUpdate(
  onUpdateVoiceSettings: (updates: Partial<VoiceSettings>) => void,
  mode: unknown
): void {
  onUpdateVoiceSettings({ outputVolumeMode: normalizeDictationOutputVolumeMode(mode) })
}

export const VoiceAudioOutputSection: VoiceAudioOutputSectionComponent = Object.assign(
  function VoiceAudioOutputSection({
    voiceSettings,
    capabilities,
    onUpdateVoiceSettings
  }: VoiceAudioOutputSectionProps): React.JSX.Element {
    const outputVolumeMode = voiceSettings.outputVolumeMode ?? 'unchanged'
    const duckedVolumePercent = clampDuckedVolumePercent(voiceSettings.duckedVolumePercent)
    const pauseDisabled = !voiceSettings.enabled || !capabilities.canPauseMedia

    return (
      <>
        <div className="flex items-center justify-between gap-4 py-2">
          <div className="space-y-0.5">
            <Label>
              {translate(
                'auto.components.settings.VoiceAudioOutputSection.pause',
                'Pause playing media when dictation starts'
              )}
            </Label>
            <p className="text-xs text-muted-foreground">
              {capabilities.canPauseMedia
                ? translate(
                    'auto.components.settings.VoiceAudioOutputSection.pauseHelp',
                    'Pauses supported media apps before listening.'
                  )
                : translate(
                    'auto.components.settings.VoiceAudioOutputSection.unsupported',
                    'Not supported on this platform yet.'
                  )}
            </p>
          </div>
          <button
            role="switch"
            aria-checked={voiceSettings.pauseMediaOnDictation}
            aria-label={translate(
              'auto.components.settings.VoiceAudioOutputSection.pause',
              'Pause playing media when dictation starts'
            )}
            disabled={pauseDisabled}
            onClick={() =>
              onUpdateVoiceSettings({ pauseMediaOnDictation: !voiceSettings.pauseMediaOnDictation })
            }
            className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full border border-transparent transition-colors ${
              voiceSettings.pauseMediaOnDictation ? 'bg-foreground' : 'bg-muted-foreground/30'
            } ${pauseDisabled ? 'cursor-not-allowed opacity-50' : 'cursor-pointer'}`}
          >
            <span
              className={`inline-block size-4 rounded-full bg-background transition-transform ${
                voiceSettings.pauseMediaOnDictation ? 'translate-x-4' : 'translate-x-0.5'
              }`}
            />
          </button>
        </div>

        <Separator />

        <div className="flex items-center justify-between gap-4 py-2">
          <div className="space-y-0.5">
            <Label>
              {translate(
                'auto.components.settings.VoiceAudioOutputSection.output',
                'System output while dictating'
              )}
            </Label>
            <p className="text-xs text-muted-foreground">
              {translate(
                'auto.components.settings.VoiceAudioOutputSection.outputHelp',
                'Reduce speaker bleed while Orca listens.'
              )}
            </p>
          </div>
          <Select
            value={outputVolumeMode}
            disabled={!voiceSettings.enabled}
            onValueChange={(mode) => applyOutputVolumeModeUpdate(onUpdateVoiceSettings, mode)}
          >
            <SelectTrigger className="w-36 bg-background/50">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {OUTPUT_MODES.map(({ mode, label }) => (
                <SelectItem
                  key={mode}
                  value={mode}
                  disabled={!canUseOutputMode(mode, capabilities)}
                >
                  {translate(`auto.components.settings.VoiceAudioOutputSection.${mode}`, label)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {outputVolumeMode === 'duck' && capabilities.canDuckOutput && (
          <div className="space-y-2 py-2">
            <Label>
              {translate(
                'auto.components.settings.VoiceAudioOutputSection.duckLabel',
                'Lower output to {{value0}}%',
                {
                  value0: duckedVolumePercent
                }
              )}
            </Label>
            <Slider
              min={0}
              max={100}
              step={5}
              value={[duckedVolumePercent]}
              disabled={!voiceSettings.enabled}
              onValueChange={(value) =>
                applyDuckedVolumeUpdate(onUpdateVoiceSettings, value[0] ?? duckedVolumePercent)
              }
            />
          </div>
        )}

        <Separator />
      </>
    )
  },
  { applyDuckedVolumeUpdate, applyOutputVolumeModeUpdate }
)
