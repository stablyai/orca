import { AudioLines } from 'lucide-react'
import { useTranslate } from '@/i18n/use-translate'
import type { NativeChatVoiceTranscriptSpeaker } from '../../../../../shared/native-chat/native-chat-voice-transcript'

/** One committed turn of a Codex voice conversation, kept in the chat beside its typed messages. */
export function NativeChatVoiceTranscriptLine(props: {
  speaker: NativeChatVoiceTranscriptSpeaker
  text: string
}): React.JSX.Element {
  const t = useTranslate()
  const label =
    props.speaker === 'user'
      ? t('components.native-chat.voice.transcriptYou', 'You, by voice')
      : t('components.native-chat.voice.transcriptVoice', 'Codex voice')
  return (
    <div className="min-w-0 max-w-full select-text text-sm [overflow-wrap:anywhere]">
      <span className="flex items-center gap-1 text-xs text-chat-foreground-faint">
        <AudioLines className="size-3" aria-hidden />
        {label}
      </span>
      <p className="whitespace-pre-wrap text-chat-foreground">{props.text}</p>
    </div>
  )
}
