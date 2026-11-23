import { NativeChatComposerDraftNotSavedIcon } from '../../drafts/NativeChatComposerDraftNotSavedIcon'
import { NativeChatRoomContext } from '../../native-chat-room-context'
import { memo, useContext } from 'react'
import { ArrowUp, CornerDownRight, ListEnd, Save, Square } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useTranslate } from '@/i18n/use-translate'
import { getScreenSubmitShortcutLabel } from '@/lib/keyboard/screen-submit-shortcut'
import { useUiLanguageRevision } from '@/i18n/use-ui-language-revision'
import type { NativeChatFollowUpBehavior } from '../../../../../../shared/native-chat/input/composer/native-chat-follow-up-behavior'
import type {
  SessionOptionDescriptor,
  SessionOptionsSurface
} from '../../../../../../shared/native-chat/input/native-chat-session-options'
import { NativeChatComposerPlanChip, useNativeChatPlanMode } from './NativeChatComposerPlanChip'
import {
  NativeChatComposerToolbar,
  type NativeChatComposerControl
} from './NativeChatComposerToolbar'
import { NativeChatSessionOptionPickers } from '../../session/options/controls/NativeChatSessionOptionPickers'
import { NativeChatComposerPermissionPicker } from '../../session/options/controls/NativeChatPermissionModePicker'
import { NativeChatComposerGoalChip } from './NativeChatComposerGoalChip'
import { NativeChatComposerPrimaryButton } from './NativeChatComposerPrimaryButton'
import { NativeChatAttachButton } from './NativeChatAttachButton'
import { NativeChatDictationButton } from './NativeChatDictationButton'
import { NativeChatContextUsageRing } from '../../usage/NativeChatContextUsageRing'
import type { NativeChatContextUsageSummary } from '../../../../../../shared/native-chat/native-chat-context-usage-summary'
import type { NativeChatOptionPickerRequest } from '../../session/options/controls/native-chat-option-picker-request'
import type { NativeChatSteerChordPreview } from '../../../../../../shared/native-chat/input/composer/use-native-chat-steer-chord-preview'

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
  /** The draft holds text or images: while the agent works, Send takes Stop's place. */
  hasDraft?: boolean
  /** While the agent works: what Cmd/Ctrl+Enter would do instead of a plain send, when it differs. */
  alternateSend?: NativeChatFollowUpBehavior
  /** This client's Stop request is in flight: the Stop control is disabled and says so. */
  isStopping?: boolean
  isDictating: boolean
  isDictationHoldMode: boolean
  onAttach: () => void
  onDictationToggle: () => void
  onDictationHoldStart: () => void
  onDictationHoldEnd: () => void
  onSend: () => void
  /** Cmd/Ctrl is held: Send names, and a click runs, what Cmd/Ctrl+Enter would do. */
  steerPreview?: NativeChatSteerChordPreview | null
  onSteerPreview?: () => void
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
  /** A launch prompt: Attach and dictation are its only controls; launching is the panel's. */
  launchPrompt?: boolean
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
  hasDraft = false,
  alternateSend,
  isStopping = false,
  isDictating,
  isDictationHoldMode,
  onAttach,
  onDictationToggle,
  onDictationHoldStart,
  onDictationHoldEnd,
  onSend,
  steerPreview = null,
  onSteerPreview,
  onStop,
  sessionOptionsSurface,
  sessionOptionsSnapshot,
  sessionOptionsPickerRequest,
  onExitGoalMode,
  contextUsage,
  focusComposer,
  agent,
  launchPrompt = false
}: NativeChatComposerActionsProps): React.JSX.Element {
  const t = useTranslate()
  useUiLanguageRevision()
  const roomReplies = useContext(NativeChatRoomContext)?.replies
  const mode = useNativeChatPlanMode({
    surface: sessionOptionsSurface,
    snapshot: sessionOptionsSnapshot,
    focusComposer
  })
  // Like Enter, a typed draft sends while the agent works; Esc still stops.
  const stops = isWorking && !hasDraft
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
  const sendReason = stops ? null : (sendBlockedReason ?? null)
  const sendHint =
    sendReason ??
    (!stops && alternateSend
      ? alternateSend === 'steer'
        ? t('components.native-chat.composer.alternateSteerHint', '{{shortcut}} to steer', {
            shortcut: getScreenSubmitShortcutLabel()
          })
        : t('components.native-chat.composer.alternateQueueHint', '{{shortcut}} to queue', {
            shortcut: getScreenSubmitShortcutLabel()
          })
      : null)
  const steerPreviewLabel =
    steerPreview === 'queue'
      ? t('components.native-chat.composer.previewQueue', 'Queue')
      : steerPreview === 'steer'
        ? t('components.native-chat.composer.previewSteer', 'Steer')
        : t('components.native-chat.composer.previewSteerQueued', 'Steer queued')
  const sendButton = editSession ? (
    <Button
      type="button"
      size="sm"
      aria-label={t('components.native-chat.queuedMessages.save', 'Save')}
      className="group-data-[terminal=true]/toolbar:size-8 pointer-coarse:group-data-[terminal=true]/toolbar:size-10"
      disabled={sendDisabled}
      onMouseDown={(event) => event.preventDefault()}
      onClick={handleCriticalAction}
    >
      <span data-composer-primary-label>
        {t('components.native-chat.queuedMessages.save', 'Save')}
      </span>
      <span data-composer-primary-icon aria-hidden="true" className="hidden">
        <Save className="size-4" />
      </span>
    </Button>
  ) : (
    <NativeChatComposerPrimaryButton
      data-native-chat-critical-action={stops ? 'stop' : undefined}
      focusComposer={focusComposer}
      aria-label={
        stops
          ? isStopping
            ? t('components.native-chat.status.stopping', 'Stopping…')
            : t('components.native-chat.stop', 'Stop the agent')
          : (sendReason ?? t('components.native-chat.composer.send', 'Send'))
      }
      disabled={sendDisabled || (stops && isStopping)}
      onClick={handleCriticalAction}
      variant={stops ? 'secondary' : 'default'}
    >
      {stops ? <Square className="size-3.5 fill-current" /> : <ArrowUp className="size-4" />}
    </NativeChatComposerPrimaryButton>
  )

  const attach = <NativeChatAttachButton disabled={attachDisabled} onAttach={onAttach} />
  const dictation = (
    <NativeChatDictationButton
      disabled={dictationDisabled}
      isDictating={isDictating}
      isHoldMode={isDictationHoldMode}
      onToggle={onDictationToggle}
      onHoldStart={onDictationHoldStart}
      onHoldEnd={onDictationHoldEnd}
    />
  )
  if (launchPrompt) {
    return (
      <div className="flex w-full items-center justify-between text-muted-foreground">
        {attach}
        {dictation}
      </div>
    )
  }

  const left: NativeChatComposerControl[] = [
    { id: 'attach', priority: 6, content: attach },
    ...(roomReplies ? [{ id: 'room-replies', priority: 6, content: roomReplies }] : []),
    {
      id: 'permissions',
      priority: 5,
      content: (
        <NativeChatComposerPermissionPicker
          surface={sessionOptionsSurface}
          snapshot={sessionOptionsSnapshot}
          {...(agent ? { agent } : {})}
        />
      )
    },
    ...(mode
      ? [
          {
            id: 'plan',
            priority: 4,
            content: <NativeChatComposerPlanChip control={mode} />,
            overflow: (close: () => void) => (
              <NativeChatComposerPlanChip control={mode} onExit={close} />
            )
          }
        ]
      : []),
    ...(onExitGoalMode
      ? [
          {
            id: 'goal',
            priority: 4,
            content: <NativeChatComposerGoalChip onExit={onExitGoalMode} />,
            overflow: (close: () => void) => (
              <NativeChatComposerGoalChip
                onExit={() => {
                  onExitGoalMode()
                  close()
                }}
              />
            )
          }
        ]
      : [])
  ]
  const right: NativeChatComposerControl[] = [
    {
      id: 'model',
      content: (
        <NativeChatSessionOptionPickers
          surface={sessionOptionsSurface}
          snapshot={sessionOptionsSnapshot}
          isWorking={isWorking}
          pickerRequest={sessionOptionsPickerRequest}
          focusComposer={focusComposer}
        />
      )
    },
    ...(contextUsage
      ? [
          {
            id: 'context',
            priority: 0,
            content: <NativeChatContextUsageRing usage={contextUsage} />
          }
        ]
      : []),
    { id: 'dictation', priority: 2, content: dictation },
    ...(draftNotSaved
      ? [{ id: 'draft', priority: 1, content: <NativeChatComposerDraftNotSavedIcon shown /> }]
      : []),
    ...(editSession
      ? [
          {
            id: 'cancel',
            priority: 3,
            content: (
              <Button type="button" variant="ghost" size="sm" onClick={editSession.cancel}>
                {t('common.cancel', 'Cancel')}
              </Button>
            )
          }
        ]
      : [])
  ]
  return (
    <NativeChatComposerToolbar
      left={left}
      focusComposer={focusComposer}
      right={right}
      primary={
        steerPreview && !editSession && (steerPreview === 'steer-queued' || !sendDisabled) ? (
          <NativeChatComposerPrimaryButton
            data-native-chat-steer-preview={steerPreview}
            aria-label={steerPreviewLabel}
            onClick={(event) => {
              // As Send: the action can change between a double-click's presses (Steer, then Steer queued).
              if (event.detail <= 1) {
                onSteerPreview?.()
              }
            }}
          >
            {steerPreview === 'queue' ? (
              <ListEnd className="size-4" />
            ) : (
              <CornerDownRight className="size-4" />
            )}
          </NativeChatComposerPrimaryButton>
        ) : sendHint ? (
          <Tooltip>
            <TooltipTrigger asChild>
              {/* A disabled button gets no pointer events, so the wrapper carries the hover. */}
              <span className="inline-flex">{sendButton}</span>
            </TooltipTrigger>
            <TooltipContent side="top" sideOffset={4}>
              {sendHint}
            </TooltipContent>
          </Tooltip>
        ) : (
          sendButton
        )
      }
    />
  )
})
