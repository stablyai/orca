import { AudioLines } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useTranslate } from '@/i18n/use-translate'
import type { NativeChatCodexVoice } from './use-native-chat-codex-voice'
import { NativeChatVoiceBars } from './NativeChatVoiceBars'

/** Turns this chat's Codex Voice mode on or off; the strip above the composer shows it. */
export function NativeChatCodexVoiceButton({
  voice
}: {
  voice: NativeChatCodexVoice
}): React.JSX.Element {
  const t = useTranslate()
  const inCall = !!voice.call && voice.call.phase !== 'ended'
  const label = inCall
    ? t('components.native-chat.voice.end', 'End Voice mode')
    : t('components.native-chat.voice.start', 'Start Voice mode')
  const blocked = inCall
    ? null
    : voice.availability === 'checking'
      ? t('components.native-chat.voice.checking', 'Checking voice support…')
      : voice.availability === 'unavailable'
        ? t(
            'components.native-chat.voice.hostUnavailable',
            "This chat's host does not support Codex Voice mode yet"
          )
        : voice.dictating
          ? t(
              'components.native-chat.voice.dictationActive',
              'Finish dictation to start Voice mode'
            )
          : null
  const hint =
    blocked ??
    (inCall
      ? label
      : t(
          'components.native-chat.voice.startHint',
          "Talk with this chat's Codex. Voice mode uses Codex's OpenAI voice service."
        ))
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        {/* A disabled button gets no pointer events, so the wrapper carries the hover. */}
        <span className="inline-flex">
          <Button
            type="button"
            variant={inCall ? 'secondary' : 'ghost'}
            size="icon-sm"
            aria-label={label}
            aria-pressed={inCall}
            disabled={blocked !== null}
            onMouseDown={(event) => event.preventDefault()}
            onClick={inCall ? voice.stop : voice.start}
            className="pointer-coarse:size-11"
          >
            {inCall ? (
              <NativeChatVoiceBars
                moving={voice.call?.phase === 'live' && voice.call.speaking !== null}
              />
            ) : (
              <AudioLines className="size-4" />
            )}
          </Button>
        </span>
      </TooltipTrigger>
      <TooltipContent side="top" sideOffset={4}>
        {hint}
      </TooltipContent>
    </Tooltip>
  )
}
