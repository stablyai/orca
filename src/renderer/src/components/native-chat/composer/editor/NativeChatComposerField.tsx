import { NativeChatPromptEditor } from './NativeChatPromptEditor'
import { notifyNativeChatComposerState } from '../focus/native-chat-composer-mount'
import type { NativeChatComposerInput } from './native-chat-composer-input'
import { useCallback, useLayoutEffect, useMemo, useRef } from 'react'
import { flushSync } from 'react-dom'
import { cn } from '@/lib/class-names'
import { NativeChatMentionMenu, NativeChatPickerMenu } from '../pickers/NativeChatAutocompleteMenus'
import { NativeChatComposerActions } from '../controls/NativeChatComposerActions'
import { NativeChatComposerNotices } from '../controls/NativeChatComposerNotices'
import { NativeChatImageAttachmentPreview } from '../../attachments/chips/NativeChatImageAttachmentPreview'

import { useNativeChatComposerDraftUnsaved } from '../../drafts/use-native-chat-draft-unsaved'
import { useNativeChatComposerGlow } from '../../native-chat-composer-glow'
import { nativeChatComposerPlaceholder } from '../controls/native-chat-composer-placeholder'
import { useTranslate } from '@/i18n/use-translate'
import { useLatestHandler } from '@/lib/use-latest-handler'
import type { NativeChatComposerFieldProps } from '../../native-chat-composer-field-props'
import { imeComposedSegment } from '@/lib/text-input/ime/ime-composed-segment'
import { acceptNativeChatPromptSuggestion } from './native-chat-prompt-suggestion-accept'

function noop(): void {}

export type { NativeChatComposerFieldProps } from '../../native-chat-composer-field-props'

export function NativeChatComposerField({
  editSession,
  draftScopeKey,
  positionTarget,
  textareaRef,
  draft,
  disabled,
  hasPty,
  canSend,
  placeholderHint,
  idleHint,
  promptSuggestion,
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
  const glowing = useNativeChatComposerGlow(draftScopeKey)
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
  // An open picker takes Tab first, so the suggestion only shows and accepts while none is.
  const suggestion = autocomplete.mode === 'none' ? promptSuggestion : undefined
  const editorKeyDownCapture = useLatestHandler((event: React.KeyboardEvent<HTMLDivElement>) => {
    if (
      !imeEnterGesture.ownsKeyDown(event) &&
      !acceptNativeChatPromptSuggestion(
        event,
        suggestion,
        textareaRef.current,
        imeEnterGesture.isComposing
      )
    ) {
      onKeyDown(event)
    }
  })
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
  const editorCompositionEnd = useLatestHandler(() => {
    const compositionWasActive = imeEnterGesture.isComposing()
    imeEnterGesture.setComposing(false)
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
              '[contain:paint]',
              glowing && 'native-chat-composer-glow'
            )}
          >
            {imageAttachments.length > 0 ? (
              <div className="mb-2 flex flex-wrap gap-2 px-1 pt-1.5">
                {imageAttachments.map((attachment, index) => (
                  <NativeChatImageAttachmentPreview
                    key={attachment.id}
                    attachment={attachment}
                    hostEnvironmentId={attachmentEnvironmentId}
                    notesScopeKey={draftScopeKey}
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
              imageRow={imageRow}
              inputRef={textareaRef}
              isComposing={imeEnterGesture.isComposing}
              initialValue={draft}
              disabled={disabled}
              onChange={editorChange}
              onKeyDownCapture={editorKeyDownCapture}
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
                      : (placeholderHint ??
                        suggestion ??
                        idleHint ??
                        nativeChatComposerPlaceholder(hasPty, canSend, afterStop, t))
              }
              // Let layout handle wrapping and touch targets; scroll after eight lines (a launch prompt: one line growing to six) without JavaScript measurement.
              // An empty launch prompt also grows to fit a wrapping placeholder: a paragraph-wide float that keeps its height, with a zero-width margin box so the caret line stays put.
              className={cn(
                'w-full bg-transparent px-2 py-1 text-sm outline-none',
                launch
                  ? 'min-h-7 max-h-[calc(6lh+0.5rem)] text-foreground placeholder:text-muted-foreground [&_p.is-editor-empty:only-child]:before:!h-auto [&_p.is-editor-empty:only-child]:before:w-full [&_p.is-editor-empty:only-child]:before:mr-[-100%]'
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
