import type {
  ClipboardEventHandler,
  CompositionEventHandler,
  KeyboardEventHandler,
  RefObject
} from 'react'
import { Image as ImageIcon, ImageOff, X } from 'lucide-react'
import { translate } from '@/i18n/i18n'
import { cn } from '@/lib/utils'
import { NATIVE_FILE_DROP_TARGET } from '../../../../shared/native-file-drop'
import { basename } from '@/lib/path'
import { isNativeChatPastedImagePath } from './native-chat-image-paste'
import type { ComposerAutocomplete, NativeChatPickerItem } from './native-chat-composer-state'
import { NativeChatMentionHint, NativeChatPickerMenu } from './NativeChatAutocompleteMenus'
import { NativeChatComposerActions } from './NativeChatComposerActions'
import { nativeChatComposerPlaceholder } from './native-chat-composer-target'
import type {
  SessionOptionDescriptor,
  SessionOptionsSurface
} from '../../../../shared/native-chat-session-options'
import type { SideQuestQuotedContext } from '@/lib/side-quest-context'
import { SideQuestQuoteCard } from './SideQuestQuoteCard'
import type { NativeChatSideQuestReadiness } from './use-native-chat-side-quest-context'

export type NativeChatComposerFieldProps = {
  textareaRef: RefObject<HTMLTextAreaElement | null>
  draft: string
  disabled: boolean
  hasPty: boolean
  canSend: boolean
  autocomplete: ComposerAutocomplete
  activeSuggestion: number
  notice: string | null
  sideQuestContext?: SideQuestQuotedContext | null
  sideQuestReadiness?: NativeChatSideQuestReadiness
  imageAttachments: readonly NativeChatComposerImageAttachment[]
  sendButtonDisabled: boolean
  isWorking: boolean
  attachDisabled: boolean
  dictationDisabled: boolean
  isDictating: boolean
  isDictationHoldMode: boolean
  onDraftChange: (value: string, element: HTMLTextAreaElement) => void
  onTextareaSelect: (element: HTMLTextAreaElement) => void
  onKeyDown: KeyboardEventHandler<HTMLTextAreaElement>
  onCompositionStart: CompositionEventHandler<HTMLTextAreaElement>
  onCompositionEnd: CompositionEventHandler<HTMLTextAreaElement>
  onPaste: ClipboardEventHandler<HTMLTextAreaElement>
  pickerListboxId: string
  onChoosePickerItem: (item: NativeChatPickerItem) => void
  onRetrySkills: () => void
  onAcceptMention: () => void
  onRemoveImageAttachment: (id: string) => void
  onRemoveSideQuestContext?: () => void
  onAttach: () => void
  onDictationToggle: () => void
  onDictationHoldStart: () => void
  onDictationHoldEnd: () => void
  onSend: () => void
  onStop?: () => void
  sessionOptionsSurface: SessionOptionsSurface | null
  sessionOptionsSnapshot: SessionOptionDescriptor[]
}

export type NativeChatComposerImageAttachment = {
  id: string
  path: string
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
  sideQuestContext = null,
  sideQuestReadiness = 'not-side-quest',
  imageAttachments,
  sendButtonDisabled,
  isWorking,
  attachDisabled,
  dictationDisabled,
  isDictating,
  isDictationHoldMode,
  onDraftChange,
  onTextareaSelect,
  onKeyDown,
  onCompositionStart,
  onCompositionEnd,
  onPaste,
  pickerListboxId,
  onChoosePickerItem,
  onRetrySkills,
  onAcceptMention,
  onRemoveImageAttachment,
  onRemoveSideQuestContext,
  onAttach,
  onDictationToggle,
  onDictationHoldStart,
  onDictationHoldEnd,
  onSend,
  onStop,
  sessionOptionsSurface,
  sessionOptionsSnapshot
}: NativeChatComposerFieldProps): React.JSX.Element {
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
            {sideQuestContext && onRemoveSideQuestContext ? (
              <div className="mb-2 px-1">
                <SideQuestQuoteCard
                  sourceLabel={sideQuestContext.sourceLabel}
                  text={sideQuestContext.text}
                  onRemove={onRemoveSideQuestContext}
                />
              </div>
            ) : null}
            {imageAttachments.length > 0 ? (
              <div className="mb-2 flex flex-wrap gap-1.5 px-1">
                {imageAttachments.map((attachment) => (
                  <div
                    key={attachment.id}
                    className="flex max-w-full items-center gap-1.5 rounded-md border border-border bg-background px-2 py-1 text-xs text-muted-foreground"
                    title={attachment.path}
                  >
                    <ImageIcon className="size-3.5 shrink-0" />
                    <span className="max-w-56 truncate">
                      {isNativeChatPastedImagePath(attachment.path)
                        ? translate(
                            'components.native-chat.composer.pastedImageLabel',
                            'Pasted image'
                          )
                        : basename(attachment.path)}
                    </span>
                    <button
                      type="button"
                      onClick={() => onRemoveImageAttachment(attachment.id)}
                      aria-label={translate(
                        'components.native-chat.composer.removeAttachment',
                        'Remove attachment'
                      )}
                      className="flex size-4 shrink-0 items-center justify-center rounded-sm text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      <X className="size-3" />
                    </button>
                  </div>
                ))}
              </div>
            ) : null}
            <textarea
              ref={textareaRef}
              value={draft}
              disabled={disabled}
              rows={2}
              onChange={(e) => onDraftChange(e.target.value, e.currentTarget)}
              onKeyDown={onKeyDown}
              onCompositionStart={onCompositionStart}
              onCompositionEnd={onCompositionEnd}
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
              placeholder={nativeChatComposerPlaceholder(hasPty, canSend, sideQuestReadiness)}
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
            {sideQuestReadiness === 'starting' ? (
              <p className="px-2 pb-1 text-xs text-muted-foreground" role="status">
                {translate(
                  'components.native-chat.sideQuest.starting',
                  'Starting the Side Quest agent… You can draft while it gets ready.'
                )}
              </p>
            ) : sideQuestReadiness === 'failed' ? (
              <p className="px-2 pb-1 text-xs text-destructive" role="alert">
                {translate(
                  'components.native-chat.sideQuest.startFailed',
                  'The agent did not become ready. Switch to Terminal to inspect it.'
                )}
              </p>
            ) : null}
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
              />
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
