import { useSyncExternalStore } from 'react'
import { Volume2, VolumeX } from 'lucide-react'
import { cn } from '@/lib/class-names'
import { useTranslate } from '@/i18n/use-translate'
import {
  getNativeChatSpeakingMessageId,
  subscribeNativeChatSpeech,
  toggleNativeChatMessageSpeech
} from './native-chat-speech-session'
import {
  getNativeChatSpeechPreferences,
  subscribeNativeChatSpeechPreferences
} from './native-chat-speech-preferences'

/**
 * Speaks one finished agent reply. Sits with Copy and reads that same text.
 * A second press, or another reply, stops it.
 */
export function NativeChatSpeakButton({
  messageId,
  markdown
}: {
  messageId: string
  markdown: string
}): React.JSX.Element | null {
  const t = useTranslate()
  const settings = useSyncExternalStore(
    subscribeNativeChatSpeechPreferences,
    getNativeChatSpeechPreferences,
    getNativeChatSpeechPreferences
  )
  const speakingId = useSyncExternalStore(
    subscribeNativeChatSpeech,
    getNativeChatSpeakingMessageId,
    getNativeChatSpeakingMessageId
  )
  if (!settings.enabled) {
    return null
  }
  const speaking = speakingId === messageId
  const label = speaking
    ? t('components.native-chat.speakMessage.stop', 'Stop speaking')
    : t('components.native-chat.speakMessage.speak', 'Speak message')
  return (
    <button
      type="button"
      onClick={() => toggleNativeChatMessageSpeech({ messageId, markdown, settings })}
      aria-label={label}
      title={label}
      className={cn(
        'flex size-6 shrink-0 items-center justify-center rounded-md text-chat-foreground-faint transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        speaking && 'text-status-success'
      )}
    >
      {speaking ? <VolumeX className="size-3.5" /> : <Volume2 className="size-3.5" />}
    </button>
  )
}
