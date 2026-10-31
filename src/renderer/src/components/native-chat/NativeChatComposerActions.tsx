import { memo } from 'react'
import { ArrowUp, CircleAlert, CornerDownRight, ListEnd, Mic, Plus, Square } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { ShortcutKeyCombo } from '@/components/ShortcutKeyCombo'
import { translate } from '@/i18n/i18n'
import { useUiLanguageRevision } from '@/i18n/use-ui-language-revision'
import type {
  SessionOptionDescriptor,
  SessionOptionsSurface
} from '../../../../shared/native-chat/input/native-chat-session-options'
import { NativeChatSessionOptionPickers } from './NativeChatSessionOptionPickers'
import { NativeChatComposerPermissionPicker } from './NativeChatPermissionModePicker'
import { NativeChatComposerGoalChip } from './NativeChatComposerGoalChip'
import { NativeChatContextUsageRing } from './NativeChatContextUsageRing'
import type { NativeChatContextUsageSummary } from './native-chat-context-usage-summary'
import type {
  NativeChatComposerSendIntent,
  NativeChatOptionPickerRequest
} from './native-chat-composer-types'
import type {
  NativeChatFollowUpBehavior,
  NativeChatSendFollowUp
} from '../../../../shared/native-chat-follow-up-behavior'
import { isMacPlatform } from './native-chat-shortcut'
import { usePlatformModifierHeld } from './use-platform-modifier-held'

/** `held`: the idle Send would be disabled here, so this control is too, with the same reason. */
export type NativeChatComposerFollowUp = NativeChatSendFollowUp & { held: boolean }

export type NativeChatComposerActionsProps = {
  editSession?: { cancel: () => void }
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
  /** Mid-turn: a send control beside Stop, so the user sees what Enter does. */
  followUp?: NativeChatComposerFollowUp
  isDictating: boolean
  isDictationHoldMode: boolean
  onAttach: () => void
  onDictationToggle: () => void
  onDictationHoldStart: () => void
  onDictationHoldEnd: () => void
  onSend: (intent?: NativeChatComposerSendIntent) => void
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

// Memoized: typing re-renders the composer per keystroke, and these controls rarely change with it.
export const NativeChatComposerActions = memo(function NativeChatComposerActions({
  editSession,
  attachDisabled,
  dictationDisabled,
  sendDisabled,
  sendBlockedReason,
  draftNotSaved,
  isWorking,
  isStopping = false,
  followUp,
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
  useUiLanguageRevision()
  const stops = isWorking
  const handleCriticalAction = (event: React.MouseEvent<HTMLButtonElement>): void => {
    // Ignore a double-click’s second press after Send becomes Stop so it cannot cancel the newly started turn.
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
  const sendButton = editSession ? (
    <Button
      type="button"
      size="sm"
      disabled={sendDisabled}
      onMouseDown={(event) => event.preventDefault()}
      onClick={handleCriticalAction}
    >
      {translate('components.native-chat.queuedMessages.save', 'Save')}
    </Button>
  ) : (
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
      size="icon-round"
      className="pointer-coarse:size-10"
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
        {/* Keep option pickers beside the session actions they affect. */}
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
        {editSession ? (
          <Button type="button" variant="ghost" size="sm" onClick={editSession.cancel}>
            {translate('common.cancel', 'Cancel')}
          </Button>
        ) : null}
        {followUp && stops && !editSession ? (
          <NativeChatFollowUpSendButton
            followUp={followUp}
            reason={followUp.held ? (sendBlockedReason ?? null) : null}
            onSend={onSend}
          />
        ) : null}
        <HeldSendReason reason={sendReason}>{sendButton}</HeldSendReason>
      </div>
    </div>
  )
})

const FOLLOW_UP_ICON = { queue: ListEnd, steer: CornerDownRight } as const

/** A click sends as Enter does and, when it would differ, a Cmd/Ctrl-click as Cmd/Ctrl+Enter does. */
function NativeChatFollowUpSendButton({
  followUp,
  reason,
  onSend
}: {
  followUp: NativeChatComposerFollowUp
  reason: string | null
  onSend: (intent?: NativeChatComposerSendIntent) => void
}): React.JSX.Element {
  const label = {
    queue: translate('components.native-chat.composer.queueMessage', 'Queue message'),
    steer: translate('components.native-chat.composer.steerMessage', 'Steer message')
  }
  const hint = {
    queue: translate('components.native-chat.composer.queueHint', 'Queue for after this turn'),
    steer: translate('components.native-chat.composer.steerHint', 'Send into the running turn')
  }
  const alternate: NativeChatFollowUpBehavior = followUp.action === 'queue' ? 'steer' : 'queue'
  const isMac = isMacPlatform()
  const offersChoice = followUp.offersChoice && !followUp.held
  // While the modifier is held, the button shows what a click would do now.
  const shown = usePlatformModifierHeld(offersChoice, isMac) ? alternate : followUp.action
  const Icon = FOLLOW_UP_ICON[shown]
  const click = translate('components.native-chat.composer.clickKey', 'Click')
  const modifier = isMac ? '⌘' : 'Ctrl'
  const button = (
    <Button
      type="button"
      aria-label={reason ?? label[shown]}
      disabled={followUp.held}
      // A press keeps focus in the draft, and a double-click's second press sends nothing more.
      onMouseDown={(event) => event.preventDefault()}
      onClick={(event) => {
        if (event.detail > 1) {
          return
        }
        if (offersChoice && (isMac ? event.metaKey : event.ctrlKey)) {
          onSend({ alternate: true })
        } else {
          onSend()
        }
      }}
      size="icon-round"
      className="pointer-coarse:size-10"
    >
      <Icon className="size-4" />
    </Button>
  )
  // Held, it reads as the idle Send does: the reason when there is one, otherwise nothing.
  if (followUp.held) {
    return <HeldSendReason reason={reason}>{button}</HeldSendReason>
  }
  return (
    <Tooltip>
      <TooltipTrigger asChild>{button}</TooltipTrigger>
      <TooltipContent side="top" sideOffset={4}>
        <span className="flex flex-col gap-1">
          <span className="flex items-center justify-between gap-2">
            <span>{hint[followUp.action]}</span>
            <FollowUpKeys keys={[isMac ? '⏎' : 'Enter']} click={offersChoice ? [click] : null} />
          </span>
          {offersChoice ? (
            <span className="flex items-center justify-between gap-2">
              <span>{hint[alternate]}</span>
              <FollowUpKeys keys={[modifier, isMac ? '⏎' : 'Enter']} click={[modifier, click]} />
            </span>
          ) : null}
        </span>
      </TooltipContent>
    </Tooltip>
  )
}

/** One way to send: its keys and, when a click differs from another way, the click too. */
function FollowUpKeys({
  keys,
  click
}: {
  keys: string[]
  click: string[] | null
}): React.JSX.Element {
  if (!click) {
    return <ShortcutKeyCombo keys={keys} />
  }
  return (
    <span className="inline-flex items-center gap-1">
      <ShortcutKeyCombo keys={keys} />
      <span className="text-xs text-muted-foreground">/</span>
      <ShortcutKeyCombo keys={click} />
    </span>
  )
}

/** A disabled send control that says why, when the user can do something about it. */
function HeldSendReason({
  reason,
  children
}: {
  reason: string | null
  children: React.JSX.Element
}): React.JSX.Element {
  if (!reason) {
    return children
  }
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        {/* A disabled button gets no pointer events, so the wrapper carries the hover. */}
        <span className="inline-flex">{children}</span>
      </TooltipTrigger>
      <TooltipContent side="top" sideOffset={4}>
        {reason}
      </TooltipContent>
    </Tooltip>
  )
}

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
