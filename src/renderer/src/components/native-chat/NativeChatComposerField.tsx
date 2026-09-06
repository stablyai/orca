import type { ClipboardEventHandler, KeyboardEventHandler, RefObject } from 'react'
import { useLayoutEffect, useRef } from 'react'
import { ImageOff } from 'lucide-react'
import type { useImeEnterGestureOwnership } from '@/lib/ime-composition-keyboard-event'
import { cn } from '@/lib/utils'
import { NATIVE_FILE_DROP_TARGET } from '../../../../shared/native-file-drop'
import type { ComposerAutocomplete, NativeChatPickerItem } from './native-chat-composer-state'
import { NativeChatMentionHint, NativeChatPickerMenu } from './NativeChatAutocompleteMenus'
import { NativeChatComposerActions } from './NativeChatComposerActions'
import { nativeChatComposerPlaceholder } from './native-chat-composer-target'
import type {
  SessionOptionDescriptor,
  SessionOptionsSurface
} from '../../../../shared/native-chat-session-options'
import type { NativeChatOptionPickerRequest } from './native-chat-composer-types'
import { NativeChatImageAttachmentPreview } from './NativeChatImageAttachmentPreview'

export type NativeChatComposerFieldProps = {
  textareaRef: RefObject<HTMLTextAreaElement | null>
  draft: string
  disabled: boolean
  hasPty: boolean
  canSend: boolean
  autocomplete: ComposerAutocomplete
  activeSuggestion: number
  notice: string | null
  imageAttachments: readonly NativeChatComposerImageAttachment[]
  sendButtonDisabled: boolean
  isWorking: boolean
  attachDisabled: boolean
  dictationDisabled: boolean
  isDictating: boolean
  isDictationHoldMode: boolean
  imeEnterGesture: ReturnType<typeof useImeEnterGestureOwnership>
  onDraftChange: (value: string, element: HTMLTextAreaElement) => void
  onTextareaSelect: (element: HTMLTextAreaElement) => void
  onKeyDown: KeyboardEventHandler<HTMLTextAreaElement>
  onImeSettled: (element: HTMLTextAreaElement) => void
  onPaste: ClipboardEventHandler<HTMLTextAreaElement>
  pickerListboxId: string
  onChoosePickerItem: (item: NativeChatPickerItem) => void
  onRetrySkills: () => void
  onAcceptMention: () => void
  onRemoveImageAttachment: (id: string) => void
  onAttach: () => void
  onDictationToggle: () => void
  onDictationHoldStart: () => void
  onDictationHoldEnd: () => void
  onSend: () => void
  onStop?: () => void
  sessionOptionsSurface: SessionOptionsSurface | null
  sessionOptionsSnapshot: SessionOptionDescriptor[]
  sessionOptionsPickerRequest?: NativeChatOptionPickerRequest | null
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
  textareaRef,
  draft,
  disabled,
  hasPty,
  canSend,
  autocomplete,
  activeSuggestion,
  notice,
  imageAttachments,
  sendButtonDisabled,
  isWorking,
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
  onAcceptMention,
  onRemoveImageAttachment,
  onAttach,
  onDictationToggle,
  onDictationHoldStart,
  onDictationHoldEnd,
  onSend,
  onStop,
  sessionOptionsSurface,
  sessionOptionsSnapshot,
  sessionOptionsPickerRequest
}: NativeChatComposerFieldProps): React.JSX.Element {
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

  const settleImeValue = (element: HTMLTextAreaElement): void => {
    if (droppedDraftClearRef.current) {
      droppedDraftClearRef.current = false
      element.value = imeComposedSegment(compositionBaseRef.current, element.value)
    }
    onImeSettled(element)
  }

  return (
    <div className="shrink-0 bg-background">
      {/* Extra bottom padding keeps the input box off the window rim. */}
      <div className="px-3 pt-2 pb-4 sm:px-4">
        <div className="relative mx-auto w-full max-w-4xl">
          {autocomplete.mode === 'slash' || autocomplete.mode === 'skill' ? (
            <NativeChatPickerMenu
              autocomplete={autocomplete}
              activeIndex={activeSuggestion}
              listboxId={pickerListboxId}
              onChoose={onChoosePickerItem}
              onRetry={onRetrySkills}
            />
          ) : null}
          {autocomplete.mode === 'mention' ? (
            <NativeChatMentionHint query={autocomplete.query} onAccept={onAcceptMention} />
          ) : null}
          {notice ? (
            <div className="mb-1.5 flex items-center gap-1.5 text-xs text-muted-foreground">
              <ImageOff className="size-3.5 shrink-0" />
              <span>{notice}</span>
            </div>
          ) : null}
          <div
            data-native-file-drop-target={NATIVE_FILE_DROP_TARGET.composer}
            className={cn(
              // Why: always-on hairline (token-level border, not focus ring) —
              // no focus/click border flash. The box is a container, not a
              // focus target.
              'rounded-lg border border-border p-1.5 shadow-xs',
              'bg-muted/50 dark:bg-input/40'
            )}
          >
            {imageAttachments.length > 0 ? (
              <div className="mb-2 flex flex-wrap gap-2 px-1 pt-1.5">
                {imageAttachments.map((attachment) => (
                  <NativeChatImageAttachmentPreview
                    key={attachment.id}
                    attachment={attachment}
                    onRemove={onRemoveImageAttachment}
                  />
                ))}
              </div>
            ) : null}
            <textarea
              ref={textareaRef}
              defaultValue={draft}
              disabled={disabled}
              rows={2}
              onChange={(e) => onDraftChange(e.target.value, e.currentTarget)}
              onKeyDown={(event) => {
                if (!imeEnterGesture.ownsKeyDown(event)) {
                  onKeyDown(event)
                }
              }}
              onKeyUp={imeEnterGesture.onKeyUp}
              onBlur={(event) => {
                const compositionWasActive = imeEnterGesture.isComposing()
                imeEnterGesture.reset()
                if (compositionWasActive) {
                  settleImeValue(event.currentTarget)
                }
              }}
              onCompositionStart={(event) => {
                compositionBaseRef.current = event.currentTarget.value
                imeEnterGesture.setComposing(true)
              }}
              onCompositionEnd={(event) => {
                const compositionWasActive = imeEnterGesture.isComposing()
                imeEnterGesture.setComposing(false)
                if (compositionWasActive) {
                  settleImeValue(event.currentTarget)
                }
              }}
              onPaste={onPaste}
              onSelect={(e) => onTextareaSelect(e.currentTarget)}
              aria-expanded={autocomplete.mode === 'slash' || autocomplete.mode === 'skill'}
              aria-controls={
                autocomplete.mode === 'slash' || autocomplete.mode === 'skill'
                  ? pickerListboxId
                  : undefined
              }
              aria-activedescendant={
                (autocomplete.mode === 'slash' || autocomplete.mode === 'skill') &&
                autocomplete.items.length > 0
                  ? `${pickerListboxId}-option-${Math.min(activeSuggestion, autocomplete.items.length - 1)}`
                  : undefined
              }
              placeholder={nativeChatComposerPlaceholder(hasPty, canSend)}
              // Why: coarse-pointer min-height follows the app's touch target convention.
              // field-sizing:content grows the field with the draft; the 8lh cap (plus
              // py-1) turns further growth into internal scrolling, and scrollbar-sleek
              // keeps that gutter off the heavy native scrollbar. Both are layout-driven,
              // so re-wrap on window/pane resize is handled without a measure pass.
              className={cn(
                'scrollbar-sleek min-h-12 w-full resize-none bg-transparent px-2 py-1 text-sm outline-none pointer-coarse:min-h-14',
                '[field-sizing:content] max-h-[calc(8lh+0.5rem)]',
                'placeholder:text-muted-foreground/60 disabled:cursor-not-allowed disabled:opacity-50'
              )}
            />
            <div className="flex flex-wrap items-center gap-2 pt-0.5">
              <NativeChatComposerActions
                attachDisabled={attachDisabled}
                dictationDisabled={dictationDisabled}
                sendDisabled={sendButtonDisabled}
                isWorking={isWorking}
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
                sessionOptionsPickerRequest={sessionOptionsPickerRequest}
              />
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
