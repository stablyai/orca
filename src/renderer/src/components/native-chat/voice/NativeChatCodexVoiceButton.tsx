import { AudioLines, PhoneOff } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useTranslate } from '@/i18n/use-translate'
import type { NativeChatCodexVoice } from './use-native-chat-codex-voice'

/** Starts or ends this chat's Codex voice conversation; the strip above the composer shows it. */
export function NativeChatCodexVoiceButton({
  voice
}: {
  voice: NativeChatCodexVoice
}): React.JSX.Element {
  const t = useTranslate()
  const inCall = !!voice.call && voice.call.phase !== 'ended'
  const label = inCall
    ? t('components.native-chat.voice.end', 'End voice conversation')
    : t('components.native-chat.voice.start', 'Start voice conversation')
  const blocked = inCall
    ? null
    : voice.availability === 'checking'
      ? t('components.native-chat.voice.checking', 'Checking voice support…')
      : voice.availability === 'unavailable'
        ? t(
            'components.native-chat.voice.hostUnavailable',
            "This chat's host does not support Codex voice yet"
          )
        : voice.dictating
          ? t('components.native-chat.voice.dictationActive', 'Finish dictation to start voice')
          : null
  const hint =
    blocked ??
    (inCall
      ? label
      : t(
          'components.native-chat.voice.startHint',
          "Talk with this chat's Codex. Speech uses Codex's OpenAI voice service."
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
            {inCall ? <PhoneOff className="size-4" /> : <AudioLines className="size-4" />}
          </Button>
        </span>
      </TooltipTrigger>
      <TooltipContent side="top" sideOffset={4}>
        {hint}
      </TooltipContent>
    </Tooltip>
  )
}
