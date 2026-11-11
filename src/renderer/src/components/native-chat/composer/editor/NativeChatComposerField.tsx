import { NativeChatPromptEditor } from './NativeChatPromptEditor'
import { notifyNativeChatComposerState } from '../focus/native-chat-composer-mount'
import type { NativeChatComposerInput } from './native-chat-composer-input'
import { useCallback, useLayoutEffect, useRef } from 'react'
import { flushSync } from 'react-dom'
import type { useImeEnterGestureOwnership } from '@/lib/text-input/ime/ime-composition-keyboard-event'
import { cn } from '@/lib/class-names'
import type { ComposerAutocomplete } from '../../../../../../shared/native-chat/input/native-chat-composer-autocomplete'
import type { NativeChatPickerItem } from '../../../../../../shared/native-chat/input/native-chat-picker-items'
import { NativeChatMentionMenu, NativeChatPickerMenu } from '../pickers/NativeChatAutocompleteMenus'
import type { NativeChatMentionFiles } from '../pickers/use-native-chat-mention-files'
import { NativeChatComposerActions } from '../controls/NativeChatComposerActions'
import { NativeChatComposerNotices } from '../controls/NativeChatComposerNotices'
import type { NativeChatComposerNotice } from '../controls/native-chat-composer-notice'
import type { NativeChatContextUsageSummary } from '../../../../../../shared/native-chat/native-chat-context-usage-summary'
import { nativeChatComposerPlaceholder } from '../controls/native-chat-composer-placeholder'
import type { NativeChatAfterStopSend } from '../submit/native-chat-composer-target'
import type {
  SessionOptionDescriptor,
  SessionOptionsSurface
} from '../../../../../../shared/native-chat/input/native-chat-session-options'
import type { NativeChatOptionPickerRequest } from '../../session/options/controls/native-chat-option-picker-request'
import type { NativeChatComposerImageAttachment } from '../../attachments/chips/native-chat-image-attachment'
import { NativeChatImageAttachmentPreview } from '../../attachments/chips/NativeChatImageAttachmentPreview'
import type { NativeChatComposerGoalMode } from '../submit/use-native-chat-composer-submit'
import { useTranslate } from '@/i18n/use-translate'
import { useNativeChatComposerDraftUnsaved } from '../../drafts/use-native-chat-draft-unsaved'
import { useLatestHandler } from '@/lib/use-latest-handler'
import type { NativeChatFollowUpBehavior } from '../../../../../../shared/native-chat/input/native-chat-follow-up-behavior'
import type { NativeChatSteerChordPreview } from '../../../../../../shared/native-chat/input/use-native-chat-steer-chord-preview'

function noop(): void {}

export type NativeChatComposerFieldProps = {
  editSession?: { cancel: () => void }
  /** Own draft persistence and native-drop routing by this pane so drops cannot land in another composer. */
  draftScopeKey: string
  positionTarget?: string
  textareaRef: React.RefObject<NativeChatComposerInput | null>
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
  /** Ordered image labels match the provider attachment order. */
  numberImages?: boolean
  /** The paired server a structured chat runs on, which reads back files stored there. */
  attachmentEnvironmentId?: string
  sendButtonDisabled: boolean
  /** Why the send button is disabled, when the user can do something about it. */
  sendBlockedReason?: string | null
  isWorking: boolean
  /** The draft holds text or images, so Send takes Stop's place while the agent works. */
  hasDraft?: boolean
  /** While the agent works: what Cmd/Ctrl+Enter would do instead of a plain send, when it differs. */
  alternateSend?: NativeChatFollowUpBehavior
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
  onKeyDown: React.KeyboardEventHandler<HTMLElement>
  onImeSettled: (element: NativeChatComposerInput) => void
  onPaste: React.ClipboardEventHandler<HTMLElement>
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
  /** Held Cmd/Ctrl: Send shows, and a click runs, what Cmd/Ctrl+Enter would do. */
  steerPreview?: NativeChatSteerChordPreview | null
  onSteerPreview?: () => void
  onStop?: () => void
  sessionOptionsSurface: SessionOptionsSurface | null
  sessionOptionsSnapshot: SessionOptionDescriptor[]
  contextUsage?: NativeChatContextUsageSummary | null
  sessionOptionsPickerRequest?: NativeChatOptionPickerRequest | null
  goalMode?: NativeChatComposerGoalMode
  agent?: string
  launchPrompt?: { placeholder: string }
  workspaceFooter?: React.ReactNode
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
  positionTarget,
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
  hasDraft = false,
  alternateSend,
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
  steerPreview = null,
  onSteerPreview,
  onStop,
  sessionOptionsSurface,
  sessionOptionsSnapshot,
  contextUsage,
  sessionOptionsPickerRequest,
  goalMode,
  agent,
  launchPrompt,
  workspaceFooter
}: NativeChatComposerFieldProps): React.JSX.Element {
  const t = useTranslate()
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
  // Remember the editor’s last draft because chip node views can flushSync a render before its onChange publishes.
  const editorDraftRef = useRef<string | null>(null)

  const settleImeValue = (element: NativeChatComposerInput): void => {
    if (droppedDraftClearRef.current) {
      droppedDraftClearRef.current = false
      element.value = imeComposedSegment(compositionBaseRef.current, element.value)
    }
    onImeSettled(element)
  }

  // Why: stable identities let the memoized editor and actions skip the per-keystroke render (#35836).
  const editorChange = useLatestHandler((input: NativeChatComposerInput) => {
    const value = input.value
    editorDraftRef.current = value
    onDraftChange(value, input)
  })
  const editorSelect = useLatestHandler(onTextareaSelect)
  const editorKeyDownCapture = useLatestHandler((event: React.KeyboardEvent<HTMLDivElement>) => {
    if (!imeEnterGesture.ownsKeyDown(event)) {
      onKeyDown(event)
    }
  })
  const editorKeyUp = useLatestHandler(imeEnterGesture.onKeyUp)
  const editorBlur = useLatestHandler(() => {
    const compositionWasActive = imeEnterGesture.isComposing()
    imeEnterGesture.reset()
    if (compositionWasActive) {
      settleImeValue(textareaRef.current!)
    }
    notifyNativeChatComposerState()
  })
  const editorCompositionStart = useLatestHandler(() => {
    if (imeEnterGesture.isComposing()) {
      imeEnterGesture.setComposing(false)
      // Settle the interrupted composition before the new one takes browser ownership.
      flushSync(() => settleImeValue(textareaRef.current!))
    }
    compositionBaseRef.current = textareaRef.current!.value
    imeEnterGesture.setComposing(true)
  })
  const editorCompositionEnd = useLatestHandler((event: React.CompositionEvent<HTMLDivElement>) => {
    const compositionWasActive = imeEnterGesture.isComposing()
    imeEnterGesture.setComposing(false, event.data)
    if (compositionWasActive) {
      settleImeValue(textareaRef.current!)
    }
    notifyNativeChatComposerState()
  })
  const editorPaste = useLatestHandler(onPaste)
  const attach = useLatestHandler(onAttach)
  const dictationToggle = useLatestHandler(onDictationToggle)
  const dictationHoldStart = useLatestHandler(onDictationHoldStart)
  const dictationHoldEnd = useLatestHandler(onDictationHoldEnd)
  const send = useLatestHandler(onSend)
  const runSteerPreview = useLatestHandler(onSteerPreview ?? noop)
  const stop = useLatestHandler(onStop ?? noop)
  const exitGoalMode = useLatestHandler(goalMode?.exit ?? noop)

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

  // Stable so the memoized option pickers keep their identity.
  const focusComposer = useCallback(() => textareaRef.current?.focus(), [textareaRef])
  // A launch prompt sits in a popover, so it takes the app's surface instead of the chat's.
  const launch = launchPrompt !== undefined

  return (
    <div
      data-composer-field={launch ? undefined : ''}
      className={launch ? undefined : '@container/composer-field shrink-0 bg-chat-pane'}
    >
      <div className={launch ? undefined : 'native-chat-composer-gutter pt-2 pb-4'}>
        <div
          className={cn('relative w-full', !launch && 'mx-auto max-w-(--chat-content-max-width)')}
        >
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
              'group/composer rounded-xl border p-1.5 shadow-xs',
              !launch && 'native-chat-composer-card',
              launch
                ? 'border-foreground/10 bg-background dark:bg-foreground/[0.04]'
                : 'border-chat-composer-border bg-chat-composer-surface',
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
              positionTarget={positionTarget}
              inputRef={textareaRef}
              isComposing={imeEnterGesture.isComposing}
              initialValue={draft}
              disabled={disabled}
              onChange={editorChange}
              onKeyDownCapture={editorKeyDownCapture}
              onKeyUp={editorKeyUp}
              onBlur={editorBlur}
              onCompositionStart={editorCompositionStart}
              onCompositionEnd={editorCompositionEnd}
              onPasteCapture={editorPaste}
              onSelect={editorSelect}
              aria-expanded={autocomplete.mode !== 'none'}
              aria-controls={autocomplete.mode !== 'none' ? pickerListboxId : undefined}
              aria-activedescendant={
                optionCount > 0
                  ? `${pickerListboxId}-option-${Math.min(activeSuggestion, optionCount - 1)}`
                  : undefined
              }
              placeholder={
                launchPrompt
                  ? launchPrompt.placeholder
                  : editSession
                    ? t('components.native-chat.queuedMessages.editMessage', 'Edit message')
                    : goalMode?.active
                      ? t(
                          'components.native-chat.goal.placeholder',
                          'Describe your goal, define measurable outcomes for best results'
                        )
                      : (unavailableHint ??
                        nativeChatComposerPlaceholder(hasPty, canSend, afterStop, t))
              }
              // Let layout handle wrapping and touch targets; scroll after eight lines (a launch prompt: one line growing to six) without JavaScript measurement.
              // An empty launch prompt also grows to fit a wrapping placeholder: a paragraph-wide float that keeps its height, with a zero-width margin box so the caret line stays put.
              className={cn(
                'w-full bg-transparent px-2 py-1 text-sm outline-none',
                launch
                  ? 'min-h-7 max-h-[calc(6lh+0.5rem)] text-foreground placeholder:text-muted-foreground [&_p.is-editor-empty:first-child]:before:!h-auto [&_p.is-editor-empty:first-child]:before:w-full [&_p.is-editor-empty:first-child]:before:mr-[-100%]'
                  : 'min-h-12 max-h-[calc(8lh+0.5rem)] text-chat-foreground-strong placeholder:text-chat-foreground-faint pointer-coarse:min-h-14',
                'overflow-y-auto scrollbar-sleek',
                // Why: the editor is a contenteditable, which `:disabled` never matches.
                '[&[contenteditable=false]]:cursor-not-allowed [&[contenteditable=false]]:opacity-50'
              )}
            />
            <div
              className={cn(
                'flex flex-wrap items-center gap-2 pt-0.5',
                // An empty launch prompt is one line; its controls appear once it has focus, content or live dictation.
                launch &&
                  !isDictating &&
                  draft === '' &&
                  imageAttachments.length === 0 &&
                  'hidden group-focus-within/composer:flex'
              )}
            >
              <NativeChatComposerActions
                editSession={editSession}
                attachDisabled={attachDisabled}
                dictationDisabled={dictationDisabled}
                sendDisabled={sendButtonDisabled}
                sendBlockedReason={sendBlockedReason}
                draftNotSaved={draftNotSaved}
                isWorking={isWorking}
                hasDraft={hasDraft}
                alternateSend={alternateSend}
                isStopping={isStopping}
                isDictating={isDictating}
                isDictationHoldMode={isDictationHoldMode}
                onAttach={attach}
                onDictationToggle={dictationToggle}
                onDictationHoldStart={dictationHoldStart}
                onDictationHoldEnd={dictationHoldEnd}
                onSend={send}
                steerPreview={steerPreview}
                onSteerPreview={runSteerPreview}
                onStop={onStop ? stop : undefined}
                sessionOptionsSurface={sessionOptionsSurface}
                sessionOptionsSnapshot={sessionOptionsSnapshot}
                contextUsage={contextUsage}
                sessionOptionsPickerRequest={sessionOptionsPickerRequest}
                focusComposer={focusComposer}
                onExitGoalMode={goalMode?.active ? exitGoalMode : undefined}
                launchPrompt={launch}
                {...(agent ? { agent } : {})}
              />
            </div>
          </div>
          {workspaceFooter}
        </div>
      </div>
    </div>
  )
}
