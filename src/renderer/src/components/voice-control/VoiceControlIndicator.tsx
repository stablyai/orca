import { Button } from '@/components/ui/button'
import { ShortcutKeyCombo } from '@/components/ShortcutKeyCombo'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useShortcutKeyDetails } from '@/hooks/useShortcutLabel'
import { translate } from '@/i18n/i18n'
import { cn } from '@/lib/utils'
import { useAppStore } from '@/store'
import { Mic, Square, X } from 'lucide-react'
import { DictationGrapes } from '../dictation/DictationGrapes'
import type { VoiceControlErrorKind } from '../../../../shared/voice-control-types'
import { dispatchVoiceControlAction } from './voice-control-events'
import {
  setVoiceControlTranscriptPanelOpen,
  useVoiceControlErrorKind,
  useVoiceControlMicLevel,
  useVoiceControlOutputLevel,
  useVoiceControlState,
  useVoiceControlToolActivity,
  useVoiceControlTranscriptPanelOpen
} from './voice-control-store'

function errorCopy(kind: VoiceControlErrorKind | null): string {
  switch (kind) {
    case 'tls-intercept':
      return translate(
        'auto.components.voice.control.VoiceControlIndicator.d32b4bb989',
        'A network filter is intercepting OpenAI traffic. Disable TLS inspection for api.openai.com.'
      )
    case 'network':
      return translate(
        'auto.components.voice.control.VoiceControlIndicator.2cfb53f520',
        'Network error reaching OpenAI.'
      )
    case 'auth':
      return translate(
        'auto.components.voice.control.VoiceControlIndicator.29829ab1ed',
        'OpenAI API key was rejected. Check it in Settings > Voice.'
      )
    case 'quota':
      return translate(
        'auto.components.voice.control.VoiceControlIndicator.ba85f4e286',
        'OpenAI quota exceeded.'
      )
    case 'unavailable':
      return translate(
        'auto.components.voice.control.VoiceControlIndicator.6247052b75',
        'OpenAI realtime is unavailable right now.'
      )
    case 'mic-denied':
      return translate(
        'auto.components.voice.control.VoiceControlIndicator.a566995efc',
        'Microphone access not granted.'
      )
    case 'key-missing':
      return translate(
        'auto.components.voice.control.VoiceControlIndicator.d5b8ea55f9',
        'Add an OpenAI API key in Settings > Voice to use full voice control.'
      )
    case 'key-unreadable':
      return translate(
        'auto.components.voice.control.VoiceControlIndicator.d8993b9285',
        'The stored OpenAI key could not be read. Re-enter it in Settings > Voice.'
      )
    case 'ice-failed':
      return translate(
        'auto.components.voice.control.VoiceControlIndicator.ac60409b1f',
        'The audio connection failed. Check your network or VPN.'
      )
    case 'unknown':
    case null:
      return translate(
        'auto.components.voice.control.VoiceControlIndicator.3c768d5d89',
        'Voice control hit an unexpected error.'
      )
  }
}

export function VoiceControlIndicator() {
  const state = useVoiceControlState()
  const errorKind = useVoiceControlErrorKind()
  const toolActivity = useVoiceControlToolActivity()
  const micLevel = useVoiceControlMicLevel()
  const outputLevel = useVoiceControlOutputLevel()
  const transcriptPanelOpen = useVoiceControlTranscriptPanelOpen()
  const openSettingsPage = useAppStore((s) => s.openSettingsPage)
  const openSettingsTarget = useAppStore((s) => s.openSettingsTarget)
  const setSettingsSearchQuery = useAppStore((s) => s.setSettingsSearchQuery)
  const shortcut = useShortcutKeyDetails('voice.control')

  const stopLabel = translate(
    'auto.components.voice.control.VoiceControlIndicator.5554f0b158',
    'Stop voice control'
  )
  const startLabel = translate(
    'auto.components.voice.control.VoiceControlIndicator.8cfbdf5630',
    'Talk to your agents'
  )
  const transcriptToggleLabel = transcriptPanelOpen
    ? translate('auto.components.voice.control.VoiceControlIndicator.7423b7184a', 'Hide transcript')
    : translate('auto.components.voice.control.VoiceControlIndicator.de37e25e2e', 'Show transcript')

  const isError = state === 'error'
  const label =
    state === 'minting' || state === 'awaiting-sdp'
      ? translate('auto.components.voice.control.VoiceControlIndicator.603efc130d', 'Connecting…')
      : state === 'stopping'
        ? translate('auto.components.voice.control.VoiceControlIndicator.2457413612', 'Stopping…')
        : state === 'live'
          ? (toolActivity ??
            translate(
              'auto.components.voice.control.VoiceControlIndicator.234fd0e2fd',
              'Listening'
            ))
          : null

  return (
    <div
      data-testid="voice-control-indicator"
      className={cn(
        'fixed bottom-12 left-1/2 z-50 -translate-x-1/2 overflow-hidden',
        'border border-border bg-popover/95 text-sm text-popover-foreground shadow-floating backdrop-blur',
        'transition-[width,border-radius,opacity] duration-200 ease-out motion-reduce:transition-none',
        isError
          ? 'w-[min(28rem,calc(100vw-2rem))] rounded-xl border-destructive/40'
          : 'max-w-[min(28rem,calc(100vw-2rem))] rounded-full'
      )}
    >
      <div className="flex h-10 items-center gap-2 px-2">
        {state === 'idle' ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                aria-label={startLabel}
                onClick={() => dispatchVoiceControlAction('start')}
              >
                <Mic className="size-3.5" />
                <span className="font-medium">{startLabel}</span>
              </Button>
            </TooltipTrigger>
            <TooltipContent side="top" sideOffset={6}>
              <span className="flex items-center gap-1.5">
                {translate(
                  'auto.components.voice.control.VoiceControlIndicator.212c6ba9e2',
                  'Open mic — talk to your agents'
                )}
                {shortcut.keys.length > 0 ? (
                  <ShortcutKeyCombo keys={shortcut.keys} doubleTap={shortcut.doubleTap} />
                ) : null}
              </span>
            </TooltipContent>
          </Tooltip>
        ) : isError ? (
          <>
            <span className="min-w-0 flex-1 truncate px-1.5 font-medium text-destructive">
              {errorCopy(errorKind)}
            </span>
            {(errorKind === 'key-missing' ||
              errorKind === 'key-unreadable' ||
              errorKind === 'auth') && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="shrink-0"
                onClick={() => {
                  // A stale Settings search would hide the exact field this opens.
                  setSettingsSearchQuery('')
                  openSettingsTarget({ pane: 'voice', repoId: null })
                  openSettingsPage()
                  dispatchVoiceControlAction('stop')
                }}
              >
                {translate(
                  'auto.components.voice.control.VoiceControlIndicator.64ad9dcc63',
                  'Open Voice settings'
                )}
              </Button>
            )}
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  aria-label={translate(
                    'auto.components.voice.control.VoiceControlIndicator.704c2fd2df',
                    'Dismiss'
                  )}
                  className="shrink-0"
                  onClick={() => dispatchVoiceControlAction('stop')}
                >
                  <X className="size-3" />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="top" sideOffset={6}>
                {translate(
                  'auto.components.voice.control.VoiceControlIndicator.337ecda30e',
                  'Dismiss and reset'
                )}
              </TooltipContent>
            </Tooltip>
          </>
        ) : (
          <>
            <DictationGrapes
              level={micLevel}
              active={state === 'live'}
              transitioning={state !== 'live'}
            />
            {state === 'live' ? (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    aria-expanded={transcriptPanelOpen}
                    aria-label={transcriptToggleLabel}
                    className="min-w-0"
                    onClick={() => setVoiceControlTranscriptPanelOpen(!transcriptPanelOpen)}
                  >
                    <span aria-hidden className="min-w-0 truncate font-medium">
                      {label}
                    </span>
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="top" sideOffset={6}>
                  {transcriptToggleLabel}
                </TooltipContent>
              </Tooltip>
            ) : (
              <span aria-hidden className="min-w-0 truncate font-medium">
                {label}
              </span>
            )}
            <span role="status" aria-live="polite" aria-atomic="true" className="sr-only">
              {label}
            </span>
            {state === 'live' ? (
              // Why: the coordinator's own voice, mirrored and muted so it reads as
              // incoming against the mic's grapes without adding a second color.
              <span aria-hidden className="inline-flex shrink-0 -scale-x-100 text-muted-foreground">
                <DictationGrapes level={outputLevel} active transitioning={false} />
              </span>
            ) : null}
            <span aria-hidden className="ml-0.5 h-4 w-px shrink-0 bg-border" />
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  aria-label={stopLabel}
                  className="shrink-0"
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => dispatchVoiceControlAction('stop')}
                >
                  <Square className="size-3 fill-current" />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="top" sideOffset={6}>
                <span className="flex items-center gap-1.5">
                  {stopLabel}
                  {shortcut.keys.length > 0 ? (
                    <ShortcutKeyCombo keys={shortcut.keys} doubleTap={shortcut.doubleTap} />
                  ) : null}
                </span>
              </TooltipContent>
            </Tooltip>
          </>
        )}
      </div>
    </div>
  )
}
