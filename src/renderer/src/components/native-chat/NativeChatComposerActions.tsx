import { ArrowUp, CircleAlert, Mic, Plus, Square } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { translate } from '@/i18n/i18n'
import type {
  SessionOptionDescriptor,
  SessionOptionsSurface
} from '../../../../shared/native-chat-session-options'
import { NativeChatSessionOptionPickers } from './NativeChatSessionOptionPickers'
import { NativeChatComposerPermissionPicker } from './NativeChatPermissionModePicker'
import { NativeChatComposerGoalChip } from './NativeChatComposerGoalChip'
import { NativeChatContextUsageRing } from './NativeChatContextUsageRing'
import type { NativeChatContextUsageSummary } from './native-chat-context-usage-summary'
import type { NativeChatOptionPickerRequest } from './native-chat-composer-types'

export type NativeChatComposerActionsProps = {
  attachDisabled: boolean
  dictationDisabled: boolean
  sendDisabled: boolean
  /** Shown on the disabled send button: what the user can do to send. */
  sendBlockedReason?: string | null
  /** Storage refused this draft; it is held in memory only. */
  draftNotSaved?: boolean
  isWorking: boolean
  /** This client's Stop request is in flight: the Stop control is disabled and says so. */
  isStopping?: boolean
  isDictating: boolean
  isDictationHoldMode: boolean
  onAttach: () => void
  onDictationToggle: () => void
  onDictationHoldStart: () => void
  onDictationHoldEnd: () => void
  onSend: () => void
  onStop?: () => void
  sessionOptionsSurface: SessionOptionsSurface | null
  sessionOptionsSnapshot: SessionOptionDescriptor[]
  sessionOptionsPickerRequest?: NativeChatOptionPickerRequest | null
  focusComposer?: () => void
  /** Present while the composer is in goal mode; the chip calls it to leave. */
  onExitGoalMode?: () => void
  /** Absent until the session has reported or the transcript can estimate. */
  contextUsage?: NativeChatContextUsageSummary | null
  /** The chat's agent, whose permission modes the picker describes. */
  agent?: string
}

export function NativeChatComposerActions({
  attachDisabled,
  dictationDisabled,
  sendDisabled,
  sendBlockedReason,
  draftNotSaved,
  isWorking,
  isStopping = false,
  isDictating,
  isDictationHoldMode,
  onAttach,
  onDictationToggle,
  onDictationHoldStart,
  onDictationHoldEnd,
  onSend,
  onStop,
  sessionOptionsSurface,
  sessionOptionsSnapshot,
  sessionOptionsPickerRequest,
  onExitGoalMode,
  contextUsage,
  focusComposer,
  agent
}: NativeChatComposerActionsProps): React.JSX.Element {
  const stops = isWorking
  const handleCriticalAction = (event: React.MouseEvent<HTMLButtonElement>): void => {
    // A double-click commonly lands after the first send has started and the button has
    // changed to Stop; ignore the second click instead of cancelling the new turn.
    if (event.detail > 1) {
      return
    }
    if (stops) {
      onStop?.()
    } else {
      onSend()
    }
  }
  const dictationLabel = isDictating
    ? translate('components.native-chat.composer.stopDictation', 'Stop dictation')
    : translate('components.native-chat.composer.startDictation', 'Start dictation')
  const sendReason = stops ? null : (sendBlockedReason ?? null)
  const sendButton = (
    <Button
      type="button"
      data-native-chat-critical-action={stops ? 'stop' : undefined}
      aria-label={
        stops
          ? isStopping
            ? translate('components.native-chat.status.stopping', 'Stopping…')
            : translate('components.native-chat.stop', 'Stop the agent')
          : (sendReason ?? translate('components.native-chat.composer.send', 'Send'))
      }
      disabled={sendDisabled || (isWorking && isStopping)}
      // A press keeps focus where it was; a focused button drops it to <body> when it disables.
      onMouseDown={(event) => event.preventDefault()}
      onClick={handleCriticalAction}
      variant={stops ? 'secondary' : 'default'}
      size="icon"
      className="size-8 rounded-full pointer-coarse:size-10"
    >
      {stops ? <Square className="size-3.5 fill-current" /> : <ArrowUp className="size-4" />}
    </Button>
  )

  return (
    <div className="flex w-full items-center justify-between gap-2 text-chat-foreground-faint">
      <div className="flex min-w-0 items-center gap-0.5">
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label={translate('components.native-chat.composer.attach', 'Attach file')}
              disabled={attachDisabled}
              onClick={onAttach}
              className="pointer-coarse:size-11"
            >
              <Plus className="size-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="top" sideOffset={4}>
            {translate('components.native-chat.composer.attach', 'Attach file')}
          </TooltipContent>
        </Tooltip>
        <NativeChatComposerPermissionPicker
          surface={sessionOptionsSurface}
          snapshot={sessionOptionsSnapshot}
          {...(agent ? { agent } : {})}
        />
        {onExitGoalMode ? <NativeChatComposerGoalChip onExit={onExitGoalMode} /> : null}
      </div>
      <div className="ml-auto flex items-center gap-1.5">
        {/* Why: keep the session picker beside the actions it affects; only the
        context ring separates it from dictation. */}
        <NativeChatSessionOptionPickers
          surface={sessionOptionsSurface}
          snapshot={sessionOptionsSnapshot}
          isWorking={isWorking}
          pickerRequest={sessionOptionsPickerRequest}
          focusComposer={focusComposer}
        />
        {contextUsage ? <NativeChatContextUsageRing usage={contextUsage} /> : null}
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant={isDictating ? 'secondary' : 'ghost'}
              size="icon-sm"
              aria-label={dictationLabel}
              disabled={dictationDisabled}
              onClick={isDictationHoldMode ? undefined : onDictationToggle}
              onPointerDown={(event) => {
                if (!isDictationHoldMode || dictationDisabled) {
                  return
                }
                event.preventDefault()
                onDictationHoldStart()
              }}
              onPointerUp={() => {
                if (isDictationHoldMode && !dictationDisabled) {
                  onDictationHoldEnd()
                }
              }}
              onPointerCancel={() => {
                if (isDictationHoldMode && !dictationDisabled) {
                  onDictationHoldEnd()
                }
              }}
              onPointerLeave={(event) => {
                if (isDictationHoldMode && event.buttons === 1 && !dictationDisabled) {
                  onDictationHoldEnd()
                }
              }}
              className="pointer-coarse:size-11"
            >
              {isDictating ? (
                <Square className="size-3.5 fill-current" />
              ) : (
                <Mic className="size-4" />
              )}
            </Button>
          </TooltipTrigger>
          <TooltipContent side="top" sideOffset={4}>
            {dictationLabel}
          </TooltipContent>
        </Tooltip>
        <DraftNotSavedIcon shown={draftNotSaved === true} />
        {sendReason ? (
          <Tooltip>
            <TooltipTrigger asChild>
              {/* A disabled button gets no pointer events, so the wrapper carries the hover. */}
              <span className="inline-flex">{sendButton}</span>
            </TooltipTrigger>
            <TooltipContent side="top" sideOffset={4}>
              {sendReason}
            </TooltipContent>
          </Tooltip>
        ) : (
          sendButton
        )}
      </div>
    </div>
  )
}

/** Shown only after storage refused the draft, so it never appears on a normal save. */
function DraftNotSavedIcon({ shown }: { shown: boolean }): React.JSX.Element | null {
  if (!shown) {
    return null
  }
  const explanation = translate(
    'components.native-chat.composer.draftNotSaved',
    "This draft couldn't be saved yet. Orca keeps trying."
  )
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span role="img" aria-label={explanation} className="inline-flex text-status-warning">
          <CircleAlert className="size-4" />
        </span>
      </TooltipTrigger>
      <TooltipContent side="top" sideOffset={4}>
        {explanation}
      </TooltipContent>
    </Tooltip>
  )
}
