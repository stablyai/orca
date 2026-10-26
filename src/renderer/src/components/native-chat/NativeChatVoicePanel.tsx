import { AudioLines, Mic, Square, Hand, Settings2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import { cn } from '@/lib/utils'

export type NativeChatVoicePanelProps = {
  modelLabel?: string
  canSubmitSpoken?: boolean
  onSubmitSpoken?: () => void
  running: boolean
  listening: boolean
  speaking: boolean
  stateLabel: string
  startDisabled: boolean
  canInterrupt: boolean
  userCaption: string
  assistantCaption: string
  notice: string
  setupNeeded: boolean
  retainedDraft: boolean
  canRetry: boolean
  onToggle: () => void
  onInterrupt: () => void
  onRetry: () => void
  onDiscard: () => void
}

export function NativeChatVoicePanel(props: NativeChatVoicePanelProps): React.JSX.Element {
  return (
    <div className="flex min-w-0 flex-1 flex-col gap-4 p-3">
      <div className="flex flex-col items-center gap-3 py-3">
        <div
          className={cn(
            'flex size-16 items-center justify-center rounded-full border border-border bg-muted',
            props.running && 'ring-2 ring-ring'
          )}
        >
          {props.listening ? (
            <Mic className="size-6 motion-safe:animate-pulse" aria-hidden />
          ) : (
            <AudioLines
              className={cn('size-6', props.speaking && 'motion-safe:animate-pulse')}
              aria-hidden
            />
          )}
        </div>
        <p role="status" className="text-center text-sm font-medium">
          {props.stateLabel}
        </p>
        {props.modelLabel ? (
          <p className="text-center text-xs text-muted-foreground">{props.modelLabel}</p>
        ) : null}
        <p className="text-center text-xs text-muted-foreground">
          {translate(
            'stsLive.hint',
            'Listening stays on until you end the conversation. Acknowledgments let the reply continue; a new question or “stop” interrupts.'
          )}
        </p>
        <Button
          className="w-full"
          disabled={!props.running && props.startDisabled}
          onClick={props.onToggle}
        >
          {props.running ? <Square className="size-4" /> : <Mic className="size-4" />}
          {props.running
            ? translate('stsLive.end', 'End voice conversation')
            : translate('stsLive.start', 'Start voice conversation')}
        </Button>
        {props.canInterrupt ? (
          <Button className="w-full" variant="outline" onClick={props.onInterrupt}>
            <Hand className="size-4" />
            {translate('stsLive.interrupt', 'Interrupt and speak')}
          </Button>
        ) : null}
        {props.canSubmitSpoken ? (
          <Button className="w-full" variant="outline" onClick={props.onSubmitSpoken}>
            {translate('stsLocal.send', 'Send spoken words')}
          </Button>
        ) : null}
      </div>
      {props.setupNeeded ? (
        <div className="space-y-2 rounded-md border border-border p-3">
          <p className="text-xs text-muted-foreground">
            {translate(
              'stsLive.setup',
              'Choose a streaming speech model for your conversation language or ElevenLabs Scribe in Voice settings. For local playback, install a system voice matching the conversation language.'
            )}
          </p>
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              useAppStore.getState().openSettingsTarget({ pane: 'voice', repoId: null })
              useAppStore.getState().openSettingsPage()
            }}
          >
            <Settings2 className="size-4" />
            {translate('stsVoice.settings', 'Voice settings')}
          </Button>
        </div>
      ) : null}
      <div
        className="min-w-0 space-y-4"
        role="log"
        aria-label={translate('stsLive.captions', 'Conversation captions')}
        aria-live="off"
      >
        <div className="space-y-1">
          <p className="text-xs font-medium text-muted-foreground">
            {translate('stsVoice.you', 'You')}
          </p>
          <p className="whitespace-pre-wrap break-words text-sm">
            {props.userCaption ||
              translate('stsLive.yourCaption', 'Your words appear here as you speak.')}
          </p>
        </div>
        <div className="space-y-1 rounded-md border border-border bg-card p-3 text-card-foreground">
          <p className="text-xs font-medium text-muted-foreground">
            {translate('stsVoice.assistant', 'Codex')}
          </p>
          <p className="whitespace-pre-wrap break-words text-sm">
            {props.assistantCaption ||
              translate('stsLive.answerCaption', 'Voice replies and captions appear here.')}
          </p>
        </div>
      </div>
      {props.notice ? (
        <p role="alert" className="break-words text-sm">
          {props.notice}
        </p>
      ) : null}
      {props.retainedDraft ? (
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" size="sm" disabled={!props.canRetry} onClick={props.onRetry}>
            {translate('stsLive.retryDraft', 'Send retained words')}
          </Button>
          <Button variant="ghost" size="sm" disabled={!props.canRetry} onClick={props.onDiscard}>
            {translate('stsLive.discardDraft', 'Discard')}
          </Button>
        </div>
      ) : null}
    </div>
  )
}
