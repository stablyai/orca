import { AudioLines, Loader2, Mic, MicOff, PhoneOff, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useTranslate } from '@/i18n/use-translate'
import { NativeChatComposerTabStrip } from '../composer/controls/NativeChatComposerTabStrip'
import type { CodexVoiceCallState, CodexVoiceFailure } from './codex-voice-call'

type Translate = ReturnType<typeof useTranslate>

function failureText(t: Translate, kind: CodexVoiceFailure): string {
  switch (kind) {
    case 'microphone-denied':
      return t(
        'components.native-chat.voice.failure.microphoneDenied',
        'Microphone access was denied. Allow it in system settings and try again.'
      )
    case 'microphone-unavailable':
      return t(
        'components.native-chat.voice.failure.microphoneUnavailable',
        'No microphone could be opened.'
      )
    case 'microphone-lost':
      return t(
        'components.native-chat.voice.failure.microphoneLost',
        'The microphone stopped, so the voice conversation ended.'
      )
    case 'connect-timeout':
      return t(
        'components.native-chat.voice.failure.connectTimeout',
        'The voice conversation could not connect in time.'
      )
    case 'busy':
      return t(
        'components.native-chat.voice.failure.busy',
        'The previous voice conversation is still closing. Try again in a moment.'
      )
    case 'not-running':
      return t(
        'components.native-chat.voice.failure.notRunning',
        'Codex is not running in this chat. Send a message, then start voice again.'
      )
    case 'unsupported':
      return t(
        'components.native-chat.voice.failure.unsupported',
        'This chat cannot start a Codex voice conversation.'
      )
    case 'answer-timeout':
      return t(
        'components.native-chat.voice.failure.answerTimeout',
        'Codex did not answer the voice request in time.'
      )
    case 'provider-exited':
      return t(
        'components.native-chat.voice.failure.providerExited',
        'Codex stopped, so the voice conversation ended.'
      )
    case 'transport-closed':
    case 'connection-lost':
      return t(
        'components.native-chat.voice.failure.connectionLost',
        'The voice connection was lost.'
      )
    case 'provider-error':
      return t('components.native-chat.voice.failure.providerError', 'Codex voice failed.')
  }
}

function statusText(t: Translate, call: CodexVoiceCallState): string {
  if (call.phase !== 'live') {
    return t('components.native-chat.voice.connecting', 'Connecting voice…')
  }
  if (call.muted) {
    return t('components.native-chat.voice.muted', 'Microphone muted')
  }
  return call.speaking === 'assistant'
    ? t('components.native-chat.voice.speaking', 'Speaking')
    : t('components.native-chat.voice.listening', 'Listening')
}

/** The live call's state and controls, on the composer's top edge like the goal strip. */
export function NativeChatCodexVoiceStrip(props: {
  call: CodexVoiceCallState
  awaitingApproval: boolean
  onMute: (muted: boolean) => void
  onEnd: () => void
  onDismiss: () => void
}): React.JSX.Element {
  const t = useTranslate()
  const { call } = props
  if (call.phase === 'ended') {
    const failure = call.failure
    return (
      <NativeChatComposerTabStrip data-native-chat-voice="failed">
        <AudioLines className="mt-0.5 size-3.5 shrink-0" aria-hidden />
        <div role="alert" className="min-w-0 flex-1 py-0.5">
          {failure ? failureText(t, failure.kind) : null}
          {failure?.message ? (
            <span className="block truncate text-2xs" title={failure.message}>
              {failure.message}
            </span>
          ) : null}
        </div>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          aria-label={t('components.native-chat.voice.dismiss', 'Dismiss')}
          onClick={props.onDismiss}
        >
          <X className="size-3.5" />
        </Button>
      </NativeChatComposerTabStrip>
    )
  }
  const caption = call.captions.at(-1)
  const muteLabel = call.muted
    ? t('components.native-chat.voice.unmute', 'Unmute microphone')
    : t('components.native-chat.voice.mute', 'Mute microphone')
  const endLabel = t('components.native-chat.voice.end', 'End voice conversation')
  return (
    <NativeChatComposerTabStrip data-native-chat-voice={call.phase}>
      {call.phase === 'live' ? (
        <AudioLines className="mt-0.5 size-3.5 shrink-0" aria-hidden />
      ) : (
        <Loader2 className="mt-0.5 size-3.5 shrink-0 animate-spin" aria-hidden />
      )}
      <div className="min-w-0 flex-1 py-0.5">
        <span role="status" className="font-medium">
          {statusText(t, call)}
          {props.awaitingApproval
            ? ` · ${t('components.native-chat.voice.awaitingApproval', 'Waiting for your approval in the chat')}`
            : null}
        </span>
        <span className="block truncate text-2xs">
          {caption
            ? `${caption.role === 'user' ? t('components.native-chat.voice.you', 'You') : t('components.native-chat.voice.voice', 'Voice')}: ${caption.text}`
            : t(
                'components.native-chat.voice.disclosure',
                "Speech runs on Codex's OpenAI voice service; the work continues in this chat's Codex."
              )}
        </span>
      </div>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            type="button"
            variant={call.muted ? 'secondary' : 'ghost'}
            size="icon-xs"
            aria-label={muteLabel}
            aria-pressed={call.muted}
            onClick={() => props.onMute(!call.muted)}
          >
            {call.muted ? <MicOff className="size-3.5" /> : <Mic className="size-3.5" />}
          </Button>
        </TooltipTrigger>
        <TooltipContent side="top" sideOffset={4}>
          {muteLabel}
        </TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label={endLabel}
            onClick={props.onEnd}
          >
            <PhoneOff className="size-3.5" />
          </Button>
        </TooltipTrigger>
        <TooltipContent side="top" sideOffset={4}>
          {endLabel}
        </TooltipContent>
      </Tooltip>
    </NativeChatComposerTabStrip>
  )
}
