import { useSyncExternalStore } from 'react'
import { Volume2, VolumeX } from 'lucide-react'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
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
 * Per-message speak affordance for an assistant reply. Sits with the copy button
 * and speaks that same text. A second press, or another reply, stops it. The
 * icon swaps while it is speaking — matching the copy button's check, no toast.
 */
const SPEAK_BUTTON_CLASS =
  'flex size-6 shrink-0 items-center justify-center rounded-md text-chat-foreground-faint transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring'

export function NativeChatSpeakButton({
  messageId,
  markdown
}: {
  messageId: string
  markdown: string
}): React.JSX.Element | null {
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
    ? translate('components.native-chat.speakMessage.stop', 'Stop speaking')
    : translate('components.native-chat.speakMessage.speak', 'Speak message')
  return (
    <button
      type="button"
      onClick={() => toggleNativeChatMessageSpeech({ messageId, markdown, settings })}
      aria-label={label}
      title={label}
      className={cn(SPEAK_BUTTON_CLASS, speaking && 'text-status-success')}
    >
      {speaking ? <VolumeX className="size-3.5" /> : <Volume2 className="size-3.5" />}
    </button>
  )
}
