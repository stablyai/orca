import { NativeChatPromptEditor } from './NativeChatPromptEditor'
import type { NativeChatComposerInput } from './native-chat-composer-input'
import type { ClipboardEventHandler, KeyboardEventHandler, RefObject } from 'react'
import { useCallback, useLayoutEffect, useMemo, useRef } from 'react'
import { flushSync } from 'react-dom'
import type { useImeEnterGestureOwnership } from '@/lib/ime-composition-keyboard-event'
import { cn } from '@/lib/utils'
import type {
  ComposerAutocomplete,
  NativeChatPickerItem
} from '../../../../shared/native-chat-composer-autocomplete'
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
} from '../../../../shared/native-chat/input/native-chat-session-options'
import type { NativeChatOptionPickerRequest } from './native-chat-composer-types'
import { NativeChatImageAttachmentPreview } from './NativeChatImageAttachmentPreview'
import type { NativeChatComposerGoalMode } from './use-native-chat-composer-submit'
import { translate } from '@/i18n/i18n'
import { useNativeChatComposerDraftUnsaved } from './use-native-chat-draft-unsaved'

export type NativeChatComposerFieldProps = {
  editSession?: { cancel: () => void }
  /** Own draft persistence and native-drop routing by this pane so drops cannot land in another composer. */
  draftScopeKey: string
  textareaRef: RefObject<NativeChatComposerInput | null>
  draft: string
  disabled: boolean
  hasPty: boolean
  canSend: boolean
  unavailableHint?: string | undefined
  autocomplete: ComposerAutocomplete
  mentionFiles: NativeChatMentionFiles
  activeSuggestion: number
  notices: readonly NativeChatComposerNotice[]
  imageAttachments: readonly NativeChatComposerImageAttachment[]
  /** A structured chat numbers its images, as its chips in the prompt read. */
  numberImages?: boolean
  /** The paired server a structured chat runs on, which reads back files stored there. */
  attachmentEnvironmentId?: string
  sendButtonDisabled: boolean
  /** Why the send button is disabled, when the user can do something about it. */
  sendBlockedReason?: string | null
  isWorking: boolean
  /** This client's Stop request is in flight: the Stop control is disabled and says so. */
  isStopping?: boolean
  /** After Stop, describe whether the host queues the next message as a card or holds the send. */
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
  sessionOptionsSurface: SessionOptionsSurface | null
  sessionOptionsSnapshot: SessionOptionDescriptor[]
  contextUsage?: NativeChatContextUsageSummary | null
  sessionOptionsPickerRequest?: NativeChatOptionPickerRequest | null
  goalMode?: NativeChatComposerGoalMode
  agent?: string
}

export type NativeChatComposerImageAttachment = {
  id: string
  /** Empty while `pending`: the clipboard image has no agent-readable path yet. */
  path: string
  connectionId?: string
  /** Show clipboard thumbnails immediately, without waiting for disk/upload completion. */
  previewUrl?: string
  /** True while the pasted image is still being written to disk or uploaded. */
  pending?: boolean
  /** The file's name while it uploads: a dropped or picked file, not a pasted image. */
  pendingName?: string
  /** Set on an image the draft names but can't send: the file to attach again. */
  unavailableName?: string
}

/** After a clear suppressed by IME, preserve only the composed segment; compare both ends because the caret need not be at the end. */
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
  editSession,
  draftScopeKey,
  textareaRef,
  draft,
  disabled,
  hasPty,
  canSend,
  unavailableHint,
  autocomplete,
  mentionFiles,
  activeSuggestion,
  notices,
  imageAttachments,
  numberImages = false,
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
  sessionOptionsSurface,
  sessionOptionsSnapshot,
  contextUsage,
  sessionOptionsPickerRequest,
  goalMode,
  agent
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
  const imageRow = useMemo(() => imageAttachments.map(({ id }) => id), [imageAttachments])
  const droppedDraftClearRef = useRef(false)
  // Remember the editor’s last draft because chip node views can flushSync a render before its onChange publishes.
  const editorDraftRef = useRef<string | null>(null)

  // Browser owns the provisional value; React synchronizes drafts only between IME sessions.
  useLayoutEffect(() => {
    const textarea = textareaRef.current
    if (!textarea) {
      return
    }
    if (imeEnterGesture.isComposing()) {
      // Remember async send clears during composition so sent text cannot leak into the next message; other drafts still yield to IME.
      droppedDraftClearRef.current ||= draft === '' && textarea.value !== ''
      return
    }
    droppedDraftClearRef.current = false
    if (draft !== editorDraftRef.current && textarea.value !== draft) {
      textarea.value = draft
    }
    editorDraftRef.current = draft
  }, [draft, imeEnterGesture, textareaRef])

  const settleImeValue = (element: NativeChatComposerInput): void => {
    if (droppedDraftClearRef.current) {
      droppedDraftClearRef.current = false
      element.value = imeComposedSegment(compositionBaseRef.current, element.value)
    }
    onImeSettled(element)
  }

  // Stable so the memoized option pickers keep their identity.
  const focusComposer = useCallback(() => textareaRef.current?.focus(), [textareaRef])

  return (
    <div className="shrink-0 bg-chat-canvas">
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
              // Use a constant container border so focus changes cannot flash it.
              'rounded-xl border border-chat-composer-border p-1.5 shadow-xs',
              'bg-chat-composer-surface',
              // Contain caret-blink repaint to the composer; keep 4px slack around overhanging attachment buttons, while menus use portals.
              '[contain:paint]'
            )}
          >
            {imageAttachments.length > 0 ? (
              <div className="mb-2 flex flex-wrap gap-2 px-1 pt-1.5">
                {imageAttachments.map((attachment, index) => (
                  <NativeChatImageAttachmentPreview
                    key={attachment.id}
                    attachment={attachment}
                    hostEnvironmentId={attachmentEnvironmentId}
                    number={numberImages ? index + 1 : undefined}
                    onRemove={onRemoveImageAttachment}
                  />
                ))}
              </div>
            ) : null}
            <NativeChatPromptEditor
              key={draftScopeKey}
              scopeKey={draftScopeKey}
              imageRow={imageRow}
              inputRef={textareaRef}
              initialValue={draft}
              disabled={disabled}
              onChange={(input) => {
                const value = input.value
                editorDraftRef.current = value
                onDraftChange(value, input)
              }}
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
              onCompositionEnd={(event) => {
                const compositionWasActive = imeEnterGesture.isComposing()
                imeEnterGesture.setComposing(false, event.data)
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
                editSession
                  ? translate('components.native-chat.queuedMessages.editMessage', 'Edit message')
                  : goalMode?.active
                    ? translate(
                        'components.native-chat.goal.placeholder',
                        'Describe your goal, define measurable outcomes for best results'
                      )
                    : (unavailableHint ?? nativeChatComposerPlaceholder(hasPty, canSend, afterStop))
              }
              // Let layout handle wrapping and touch targets; scroll after eight lines without JavaScript measurement.
              className={cn(
                'min-h-12 w-full bg-transparent px-2 py-1 text-sm text-chat-foreground-strong outline-none pointer-coarse:min-h-14',
                'max-h-[calc(8lh+0.5rem)] overflow-y-auto scrollbar-sleek',
                // Why: the editor is a contenteditable, which `:disabled` never matches.
                'placeholder:text-chat-foreground-faint [&[contenteditable=false]]:cursor-not-allowed [&[contenteditable=false]]:opacity-50'
              )}
            />
            <div className="flex flex-wrap items-center gap-2 pt-0.5">
              <NativeChatComposerActions
                editSession={editSession}
                attachDisabled={attachDisabled}
                dictationDisabled={dictationDisabled}
                sendDisabled={sendButtonDisabled}
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
                sessionOptionsSurface={sessionOptionsSurface}
                sessionOptionsSnapshot={sessionOptionsSnapshot}
                contextUsage={contextUsage}
                sessionOptionsPickerRequest={sessionOptionsPickerRequest}
                focusComposer={focusComposer}
                onExitGoalMode={goalMode?.active ? goalMode.exit : undefined}
                {...(agent ? { agent } : {})}
              />
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
