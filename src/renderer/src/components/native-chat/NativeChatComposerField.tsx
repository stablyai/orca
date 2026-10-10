import { NativeChatPromptEditor } from './NativeChatPromptEditor'
import type { NativeChatComposerInput } from './native-chat-composer-input'
import type { ClipboardEventHandler, KeyboardEventHandler, RefObject } from 'react'
import { useCallback, useLayoutEffect, useRef } from 'react'
import { flushSync } from 'react-dom'
import type { useImeEnterGestureOwnership } from '@/lib/ime-composition-keyboard-event'
import { cn } from '@/lib/utils'
import type { ComposerAutocomplete, NativeChatPickerItem } from './native-chat-composer-state'
import { NativeChatMentionMenu, NativeChatPickerMenu } from './NativeChatAutocompleteMenus'
import type { NativeChatMentionFiles } from './use-native-chat-mention-files'
import { NativeChatComposerActions } from './NativeChatComposerActions'
import { NativeChatComposerNotices } from './NativeChatComposerNotices'
import type { NativeChatComposerNotice } from './native-chat-composer-notice'
import type { NativeChatContextUsageSummary } from './native-chat-context-usage-summary'
import {
  nativeChatComposerPlaceholder,
  type NativeChatAfterStopSend
} from './native-chat-composer-target'
import type {
  SessionOptionDescriptor,
  SessionOptionsSurface
} from '../../../../shared/native-chat-session-options'
import type { NativeChatOptionPickerRequest } from './native-chat-composer-types'
import {
  nativeChatComposerPrimaryButton,
  type NativeChatQueueResume
} from './native-chat-composer-primary-action'
import { NativeChatImageAttachmentPreview } from './NativeChatImageAttachmentPreview'
import { NativeChatQueueSendConfirmDialog } from './NativeChatQueueSendConfirmDialog'
import type { NativeChatQueueSendConfirm } from './use-native-chat-held-queue-composer-send'
import type { NativeChatComposerGoalMode } from './use-native-chat-composer-submit'
import { translate } from '@/i18n/i18n'
import { useNativeChatComposerDraftUnsaved } from './use-native-chat-draft-unsaved'

export type NativeChatComposerFieldProps = {
  /** Pane identity published to the drop pipeline so a native file drop lands
   *  only in the composer it was dropped on. */
  /** Owner of the draft the editor's document is saved with. */
  draftScopeKey: string
  textareaRef: RefObject<NativeChatComposerInput | null>
  draft: string
  disabled: boolean
  hasPty: boolean
  canSend: boolean
  autocomplete: ComposerAutocomplete
  mentionFiles: NativeChatMentionFiles
  activeSuggestion: number
  notices: readonly NativeChatComposerNotice[]
  imageAttachments: readonly NativeChatComposerImageAttachment[]
  /** The paired server a structured chat runs on, which reads back files stored there. */
  attachmentEnvironmentId?: string
  sendButtonDisabled: boolean
  /** Why the send button is disabled, when the user can do something about it. */
  sendBlockedReason?: string | null
  isWorking: boolean
  /** This client's Stop request is in flight: the Stop control is disabled and says so. */
  isStopping?: boolean
  /** The chat reads Stopping: the placeholder says a message runs after the stop, queued as a
   *  card where the host holds sends as cards (`queue`), else sent and held by the host (`send`). */
  afterStop?: NativeChatAfterStopSend
  attachDisabled: boolean
  dictationDisabled: boolean
  isDictating: boolean
  isDictationHoldMode: boolean
  imeEnterGesture: ReturnType<typeof useImeEnterGestureOwnership>
  onDraftChange: (value: string, element: NativeChatComposerInput) => void
  onTextareaSelect: (element: NativeChatComposerInput) => void
  onKeyDown: KeyboardEventHandler<HTMLElement>
  onImeSettled: (element: NativeChatComposerInput) => void
  onPaste: ClipboardEventHandler<HTMLElement>
  pickerListboxId: string
  onChoosePickerItem: (item: NativeChatPickerItem) => void
  onRetrySkills: () => void
  onChooseMentionFile: (path: string) => void
  onRemoveImageAttachment: (id: string) => void
  onAttach: () => void
  onDictationToggle: () => void
  onDictationHoldStart: () => void
  onDictationHoldEnd: () => void
  onSend: () => void
  onStop?: () => void
  queueResume?: NativeChatQueueResume | undefined
  queueSendConfirm?: NativeChatQueueSendConfirm | null
  sessionOptionsSurface: SessionOptionsSurface | null
  sessionOptionsSnapshot: SessionOptionDescriptor[]
  contextUsage?: NativeChatContextUsageSummary | null
  sessionOptionsPickerRequest?: NativeChatOptionPickerRequest | null
  goalMode?: NativeChatComposerGoalMode
}

export type NativeChatComposerImageAttachment = {
  id: string
  /** Empty while `pending`: the clipboard image has no agent-readable path yet. */
  path: string
  connectionId?: string
  /** Clipboard thumbnail (blob/data URL) rendered before — and after — the file
   *  lands, so the chip never waits on a disk round-trip to show something. */
  previewUrl?: string
  /** True while the pasted image is still being written to disk or uploaded. */
  pending?: boolean
  /** The file's name while it uploads: a dropped or picked file, not a pasted image. */
  pendingName?: string
  /** Set on an image the draft names but can't send: the file to attach again. */
  unavailableName?: string
}

/**
 * Applies a draft clear that was dropped mid-composition: everything the field held when the
 * IME started is what the clear was meant to erase, so only the composed segment survives.
 * Diffed from both ends because an IME edits at the caret, which need not be the end.
 */
function imeComposedSegment(base: string, settled: string): string {
  const limit = Math.min(base.length, settled.length)
  let prefix = 0
  while (prefix < limit && base[prefix] === settled[prefix]) {
    prefix += 1
  }
  let suffix = 0
  while (
    suffix < limit - prefix &&
    base[base.length - 1 - suffix] === settled[settled.length - 1 - suffix]
  ) {
    suffix += 1
  }
  return settled.slice(prefix, settled.length - suffix)
}

export function NativeChatComposerField({
  draftScopeKey,
  textareaRef,
  draft,
  disabled,
  hasPty,
  canSend,
  autocomplete,
  mentionFiles,
  activeSuggestion,
  notices,
  imageAttachments,
  attachmentEnvironmentId,
  sendButtonDisabled,
  sendBlockedReason,
  isWorking,
  isStopping = false,
  afterStop,
  attachDisabled,
  dictationDisabled,
  isDictating,
  isDictationHoldMode,
  imeEnterGesture,
  onDraftChange,
  onTextareaSelect,
  onKeyDown,
  onImeSettled,
  onPaste,
  pickerListboxId,
  onChoosePickerItem,
  onRetrySkills,
  onChooseMentionFile,
  onRemoveImageAttachment,
  onAttach,
  onDictationToggle,
  onDictationHoldStart,
  onDictationHoldEnd,
  onSend,
  onStop,
  queueResume,
  queueSendConfirm = null,
  sessionOptionsSurface,
  sessionOptionsSnapshot,
  contextUsage,
  sessionOptionsPickerRequest,
  goalMode
}: NativeChatComposerFieldProps): React.JSX.Element {
  const draftNotSaved = useNativeChatComposerDraftUnsaved(draftScopeKey)
  const optionCount =
    autocomplete.mode === 'slash'
      ? autocomplete.items.length
      : autocomplete.mode === 'mention'
        ? mentionFiles.files.length
        : 0
  // Value the IME started from, and whether a programmatic clear was dropped on top of it.
  const compositionBaseRef = useRef('')
  const droppedDraftClearRef = useRef(false)

  // Browser owns the provisional value; React synchronizes drafts only between IME sessions.
  useLayoutEffect(() => {
    const textarea = textareaRef.current
    if (!textarea) {
      return
    }
    if (imeEnterGesture.isComposing()) {
      // Why: a clear (an async structured send confirming) would otherwise be lost outright and
      // the sent text would ride along into the next message. Only clears are carved out of
      // browser ownership; every other programmatic draft still loses to the live composition.
      droppedDraftClearRef.current ||= draft === '' && textarea.value !== ''
      return
    }
    droppedDraftClearRef.current = false
    if (textarea.value === draft) {
      return
    }
    textarea.value = draft
  }, [draft, imeEnterGesture, textareaRef])

  const settleImeValue = (element: NativeChatComposerInput): void => {
    if (droppedDraftClearRef.current) {
      droppedDraftClearRef.current = false
      element.value = imeComposedSegment(compositionBaseRef.current, element.value)
    }
    onImeSettled(element)
  }

  const primary = nativeChatComposerPrimaryButton({
    isWorking,
    composerEmpty: draft.trim() === '' && imageAttachments.length === 0,
    queueResume,
    composerDisabled: disabled,
    sendDisabled: sendButtonDisabled
  })
  const { resume } = primary
  // Stable so the memoized option pickers keep their identity.
  const focusComposer = useCallback(() => textareaRef.current?.focus(), [textareaRef])
  // The button disables while resuming, which drops its focus; typing is what comes next.
  const resumeQueue = (): void => {
    resume?.()
    textareaRef.current?.focus()
  }

  return (
    <div className="shrink-0 bg-chat-canvas">
      {/* Extra bottom padding keeps the input box off the window rim. */}
      <div className="px-3 pt-2 pb-4 sm:px-4">
        <div className="relative mx-auto w-full max-w-(--chat-content-max-width)">
          {autocomplete.mode === 'slash' ? (
            <NativeChatPickerMenu
              autocomplete={autocomplete}
              activeIndex={activeSuggestion}
              listboxId={pickerListboxId}
              onChoose={onChoosePickerItem}
              onRetry={onRetrySkills}
            />
          ) : null}
          {autocomplete.mode === 'mention' ? (
            <NativeChatMentionMenu
              mention={mentionFiles}
              activeIndex={activeSuggestion}
              listboxId={pickerListboxId}
              onChoose={onChooseMentionFile}
            />
          ) : null}
          <NativeChatComposerNotices
            notices={notices.map((notice) =>
              // A dismissed row takes its focused × with it; the message box gets focus back.
              notice.onDismiss
                ? {
                    ...notice,
                    onDismiss: () => {
                      notice.onDismiss?.()
                      textareaRef.current?.focus()
                    }
                  }
                : notice
            )}
            className="mb-1.5"
          />
          <div
            className={cn(
              // Why: always-on hairline (token-level border, not focus ring) —
              // no focus/click border flash. The box is a container, not a
              // focus target.
              'rounded-xl border border-chat-composer-border p-1.5 shadow-xs',
              'bg-chat-composer-surface',
              // Why (#10481): the native caret blink invalidates paint up to the
              // nearest containment boundary; without this the whole transcript
              // re-rasterizes twice a second. Pickers are siblings and every menu
              // and tooltip in here is a Radix portal, so nothing floating clips.
              // Tightest descendant is the attachment remove button, which
              // overhangs its thumbnail by 6px and clears this box's padding by
              // 4px — keep that slack if the padding below ever shrinks.
              '[contain:paint]'
            )}
          >
            {imageAttachments.length > 0 ? (
              <div className="mb-2 flex flex-wrap gap-2 px-1 pt-1.5">
                {imageAttachments.map((attachment) => (
                  <NativeChatImageAttachmentPreview
                    key={attachment.id}
                    attachment={attachment}
                    hostEnvironmentId={attachmentEnvironmentId}
                    onRemove={onRemoveImageAttachment}
                  />
                ))}
              </div>
            ) : null}
            <NativeChatPromptEditor
              key={draftScopeKey}
              scopeKey={draftScopeKey}
              inputRef={textareaRef}
              initialValue={draft}
              disabled={disabled}
              onChange={(input) => onDraftChange(input.value, input)}
              onKeyDownCapture={(event) => {
                if (!imeEnterGesture.ownsKeyDown(event)) {
                  onKeyDown(event)
                }
              }}
              onKeyUp={imeEnterGesture.onKeyUp}
              onBlur={() => {
                const compositionWasActive = imeEnterGesture.isComposing()
                imeEnterGesture.reset()
                if (compositionWasActive) {
                  settleImeValue(textareaRef.current!)
                }
              }}
              onCompositionStart={() => {
                if (imeEnterGesture.isComposing()) {
                  imeEnterGesture.setComposing(false)
                  // Settle the interrupted composition before the new one takes browser ownership.
                  flushSync(() => settleImeValue(textareaRef.current!))
                }
                compositionBaseRef.current = textareaRef.current!.value
                imeEnterGesture.setComposing(true)
              }}
              onCompositionEnd={() => {
                const compositionWasActive = imeEnterGesture.isComposing()
                imeEnterGesture.setComposing(false)
                if (compositionWasActive) {
                  settleImeValue(textareaRef.current!)
                }
              }}
              onPasteCapture={onPaste}
              onSelect={onTextareaSelect}
              aria-expanded={autocomplete.mode !== 'none'}
              aria-controls={autocomplete.mode !== 'none' ? pickerListboxId : undefined}
              aria-activedescendant={
                optionCount > 0
                  ? `${pickerListboxId}-option-${Math.min(activeSuggestion, optionCount - 1)}`
                  : undefined
              }
              placeholder={
                goalMode?.active
                  ? translate(
                      'components.native-chat.goal.placeholder',
                      'Describe your goal, define measurable outcomes for best results'
                    )
                  : nativeChatComposerPlaceholder(hasPty, canSend, afterStop)
              }
              // Why: coarse-pointer min-height follows the app's touch target convention.
              // Editable content grows naturally; the 8lh cap (plus
              // py-1) turns further growth into internal scrolling, and scrollbar-sleek
              // keeps that gutter off the heavy native scrollbar. Both are layout-driven,
              // so re-wrap on window/pane resize is handled without a measure pass.
              className={cn(
                'min-h-12 w-full bg-transparent px-2 py-1 text-sm native-chat-message-text text-chat-foreground-strong outline-none pointer-coarse:min-h-14',
                'max-h-[calc(8lh+0.5rem)] overflow-y-auto scrollbar-sleek',
                'placeholder:text-chat-foreground-faint disabled:cursor-not-allowed disabled:opacity-50'
              )}
            />
            <div className="flex flex-wrap items-center gap-2 pt-0.5">
              <NativeChatComposerActions
                attachDisabled={attachDisabled}
                dictationDisabled={dictationDisabled}
                sendDisabled={primary.disabled}
                primaryAction={primary.action}
                sendBlockedReason={sendBlockedReason}
                draftNotSaved={draftNotSaved}
                isWorking={isWorking}
                isStopping={isStopping}
                isDictating={isDictating}
                isDictationHoldMode={isDictationHoldMode}
                onAttach={onAttach}
                onDictationToggle={onDictationToggle}
                onDictationHoldStart={onDictationHoldStart}
                onDictationHoldEnd={onDictationHoldEnd}
                onSend={onSend}
                onStop={onStop}
                {...(resume ? { onResume: resumeQueue } : {})}
                sessionOptionsSurface={sessionOptionsSurface}
                sessionOptionsSnapshot={sessionOptionsSnapshot}
                contextUsage={contextUsage}
                sessionOptionsPickerRequest={sessionOptionsPickerRequest}
                focusComposer={focusComposer}
                onExitGoalMode={goalMode?.active ? goalMode.exit : undefined}
              />
            </div>
          </div>
        </div>
      </div>
      <NativeChatQueueSendConfirmDialog confirm={queueSendConfirm} focusComposer={focusComposer} />
    </div>
  )
}
