import { useSyncExternalStore } from 'react'
import { Volume2, VolumeX } from 'lucide-react'
import { translate } from '@/i18n/i18n'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import {
  isSpeakBackEnabled,
  setSpeakBackEnabled,
  subscribeToSpeakBackEnabled
} from '@/lib/voice/desktop-speak-back-store'

/**
 * Titlebar on/off for desktop speak-back — the same per-surface toggle the
 * phone has, so a finished agent turn is spoken aloud only when the operator
 * has asked for it. Default off.
 */
export function SpeakBackToggle(): React.JSX.Element {
  const enabled = useSyncExternalStore(subscribeToSpeakBackEnabled, isSpeakBackEnabled)

  const label = enabled
    ? translate('auto.components.voice.SpeakBackToggle.on', 'Speak agent replies: on')
    : translate('auto.components.voice.SpeakBackToggle.off', 'Speak agent replies: off')

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          className="titlebar-icon-button"
          aria-label={label}
          aria-pressed={enabled}
          onClick={() => setSpeakBackEnabled(!enabled)}
          style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
        >
          {enabled ? <Volume2 size={14} /> : <VolumeX size={14} />}
        </button>
      </TooltipTrigger>
      <TooltipContent side="bottom" sideOffset={6}>
        {label}
      </TooltipContent>
    </Tooltip>
  )
}
