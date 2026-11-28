// The item view's comment box: chat's prompt editor and attachment pieces in one row (attach, text, arrows,
// mic, send), the text on its own row above them from its second line or in a narrow pane; while the agent's
// question waits, "Replying to" names it above that row. Enter sends, Shift+Enter
// adds a line; images paste, drop or attach as thumbnails with an "Image #N" pill at the caret, other
// files as `@path` pills. Uploads go to the item's chat on the bot's host, which then holds them as its own.
import { useCallback, useLayoutEffect, useMemo, useRef, useState, type Ref } from 'react'
import { ArrowUp } from 'lucide-react'
import { useTranslate } from '@/i18n/use-translate'
import { useLatestHandler } from '@/lib/use-latest-handler'
import { useImeEnterGestureOwnership } from '@/lib/text-input/ime/ime-composition-keyboard-event'
import { NativeChatComposerPrimaryButton } from '../../native-chat/composer/controls/NativeChatComposerPrimaryButton'
import { NativeChatAttachButton } from '../../native-chat/composer/controls/NativeChatAttachButton'
import { NativeChatDictationButton } from '../../native-chat/composer/controls/NativeChatDictationButton'
import { useNativeChatDictation } from '../../native-chat/composer/editor/use-native-chat-dictation'
import { NativeChatComposerNotices } from '../../native-chat/composer/controls/NativeChatComposerNotices'
import { useNativeChatComposerNotice } from '../../native-chat/composer/controls/use-native-chat-composer-notice'
import { NativeChatPromptEditor } from '../../native-chat/composer/editor/NativeChatPromptEditor'
import { useNativeChatComposerKeyDown } from '../../native-chat/composer/editor/use-native-chat-composer-keydown'
import { NativeChatComposerMenus } from '../../native-chat/composer/pickers/NativeChatComposerMenus'
import { NativeChatComposerRoomProvider } from '../../native-chat/NativeChatComposerRoomProvider'
import type { NativeChatComposerInput } from '../../native-chat/composer/editor/native-chat-composer-input'
import { useNativeChatComposerHandle } from '../../native-chat/composer/editor/use-native-chat-composer-handle'
import { useNativeChatDraftEvents } from '../../native-chat/composer/editor/use-native-chat-draft-events'
import type { NativeChatComposerHandle } from '../../native-chat/composer/native-chat-composer-types'
import { NativeChatImageAttachmentPreview } from '../../native-chat/attachments/chips/NativeChatImageAttachmentPreview'
import { useNativeChatComposerAttachments } from '../../native-chat/attachments/chips/use-native-chat-composer-attachments'
import { useNativeChatFileDrops } from '../../native-chat/attachments/intake/use-native-chat-file-drops'
import type { NativeChatAttachmentOwner } from '../../native-chat/attachments/uploads/native-chat-attachment-owner'
import { useNativeChatDraft } from '../../native-chat/drafts/use-native-chat-draft'
import {
  clearNativeChatComposerDraftIfUnchanged,
  readNativeChatComposerDraft
} from '../../native-chat/drafts/native-chat-composer-draft-store'
import {
  admitNativeChatPastedText,
  projectNativeChatPastedText
} from '../../native-chat/paste/native-chat-composer-pasted-text-references'
import { imageReferencesToPromptMarkers } from '../../../../../shared/native-chat/transcript/images/native-chat-sent-image-prompt-markers'
import { botItemHeldAnswersLimitNotice } from './bot-item-held-answers'
import {
  useBotItemCommentBoxHandle,
  type BotItemCommentBoxHandle
} from './use-bot-item-comment-box-handle'

export type { BotItemCommentBoxHandle }
import type { Bot } from '../../../../../shared/bot-types'
import type { BotItemReplyMarkState } from '../../../../../shared/bots/bot-item-reply-target'
import { BOT_ITEM_LIMITS, type BotItem } from '../../../../../shared/bots/bot-items'
import { botItemCommentDraftScope } from './bot-item-comment-draft'
import { useKeepFloatingTerminalTriggerClear } from '../../floating-terminal/trigger/floating-terminal-trigger-keep-clear'
import { BOT_ITEM_TOOL_ROW_TOUCH_FIT } from './BotItemStepper'
import {
  BotItemReplyingTo,
  useBotItemReplyMark,
  type BotItemWaitingQuestion
} from './BotItemReplyingTo'
import { cn } from '@/lib/class-names'
import { useBotItemCommentStacked } from './use-bot-item-comment-stacked'
import { BotItemCommentRoom, useBotItemCommentPickers } from './bot-item-comment-pickers'
import type { useBotItemQuestionSteps } from './use-bot-item-question-steps'
import {
  useBotItemCommentAttachments,
  type BotItemCommentAttachTarget
} from './use-bot-item-comment-attachments'

const NO_TARGET = () => null
const NO_REPLY_MARK: BotItemReplyMarkState = { hidden: false, hide: () => {}, show: () => {} }

type BotItemCommentBoxProps = Parameters<typeof BotItemCommentField>[0]

export function BotItemCommentBox(props: BotItemCommentBoxProps): React.JSX.Element {
  return (
    <BotItemCommentRoom bot={props.bot}>
      <BotItemCommentField {...props} />
    </BotItemCommentRoom>
  )
}

function BotItemCommentField({
  bot,
  item,
  attachTo,
  onSend,
  hidden = false,
  nav,
  question,
  replyMark = NO_REPLY_MARK,
  onShowQuestion,
  ref
}: {
  bot: Bot
  item: BotItem
  /** The bot's folder workspace and host, which file drops and uploads resolve against. */
  attachTo: BotItemCommentAttachTarget | null
  /** Takes the comment as the box empties, with the waiting line "Replying to" names (null once
   *  hidden): it shows and goes to the host from there. */
  onSend: ReturnType<typeof useBotItemQuestionSteps>['fromBox']
  /** Not on screen: files dropped on the pane are not taken into its hidden draft. */
  hidden?: boolean
  /** The agent's question the item waits on: its first line, and whether it gave quick replies. */
  question?: BotItemWaitingQuestion | null
  /** Its "Replying to" closed (×), kept with the draft; absent with no question to name. */
  replyMark?: BotItemReplyMarkState
  /** Brings the comment that asks the question into view, by its event id. */
  onShowQuestion?: (eventId: string) => void
  /** The item pane's previous / next arrows, between the attach and mic buttons. */
  nav?: React.ReactNode
  ref?: Ref<BotItemCommentBoxHandle>
}): React.JSX.Element {
  const t = useTranslate()
  const scopeKey = botItemCommentDraftScope(bot, item.uid)
  const ime = useImeEnterGestureOwnership()
  const { draft, setDraft, flushDraftAppends } = useNativeChatDraft(scopeKey, ime.isComposing)
  const [caret, setCaret] = useState(draft.length)
  const { notices, setNotice } = useNativeChatComposerNotice()
  const box = useRef<HTMLDivElement | null>(null)
  const input = useRef<NativeChatComposerInput | null>(null)
  const composer = useRef<NativeChatComposerHandle | null>(null)
  useKeepFloatingTerminalTriggerClear(box)
  const dictation = useNativeChatDictation(input, false)
  const access = useBotItemCommentAttachments(bot, item, attachTo)
  const [activeSuggestion, setActiveSuggestion] = useState(0)
  const { picker, mentions, commentSkills } = useBotItemCommentPickers({
    bot,
    scopeKey,
    worktreeId: attachTo?.worktreeId,
    draft,
    caret,
    notices,
    setNotice,
    isComposing: ime.isComposing,
    input,
    setDraft,
    setCaret,
    setActiveSuggestion
  })

  const attachments = useNativeChatComposerAttachments({
    attachmentScopeKey: scopeKey,
    allowWithoutTarget: true,
    imageReferences: true,
    caret,
    disabled: false,
    isComposing: ime.isComposing,
    resolveTarget: NO_TARGET,
    textareaRef: input,
    setCaret,
    setDraft,
    setNotice
  })
  const fileDrops = useNativeChatFileDrops({
    paneKey: scopeKey,
    draftScopeKey: scopeKey,
    targetPtyId: null,
    terminalTabId: scopeKey,
    structuredWorktreeId: access.session ? attachTo?.worktreeId : undefined,
    structuredSession: access.session ?? undefined,
    disabled: !access.session || hidden,
    attachResolvedPaths: attachments.attachResolvedPaths,
    pendingChips: attachments.pendingChips,
    setNotice
  })
  const { blocked } = access
  const ownerOfSession = fileDrops.resolveAttachmentOwner
  // Pastes say why nothing attaches where the item's chat can't take files.
  const resolveAttachmentOwner = useCallback(
    (): NativeChatAttachmentOwner =>
      blocked ? { kind: 'not-ready', notice: blocked } : ownerOfSession(),
    [blocked, ownerOfSession]
  )
  const handlePaste = useNativeChatComposerHandle(composer, {
    attachmentScopeKey: scopeKey,
    textareaRef: input,
    isComposing: ime.isComposing,
    caret,
    setDraft,
    setCaret,
    setActiveSuggestion,
    targetKey: JSON.stringify([scopeKey, access.session?.sessionId]),
    disabled: false,
    resolveAttachmentOwner,
    attachCopiedFiles: fileDrops.attachExternalPaths,
    captureCopiedFiles: fileDrops.captureCopiedFiles,
    captureExternalPaths: fileDrops.captureExternalPaths,
    beginPendingImageAttachment: attachments.beginPendingImageAttachment,
    resolvePendingImageAttachment: attachments.pendingChips.resolve,
    revealPendingImageAttachment: attachments.revealPendingImageAttachment,
    dropPendingImageAttachment: attachments.dropPendingImageAttachment,
    pastedTextEditor: attachments.scopeEditor,
    // A paste past the comment's limit becomes a "Pasted text" file instead of being refused.
    longPasteThreshold: BOT_ITEM_LIMITS.text,
    setNotice
  })
  const events = useNativeChatDraftEvents({
    draft,
    setDraft,
    setCaret,
    setActiveSuggestion,
    handleDraftOrCaretChange: picker.handleDraftOrCaretChange,
    flushDraftAppends,
    flushPendingAttachments: attachments.flushPendingAttachments
  })
  // The draft changes outside the editor too (a send clears it); the editor shows the store's text.
  // `shown` is the editor's last published text too: a pill's node view can render before it publishes.
  const shown = useRef(draft)
  useLayoutEffect(() => {
    const node = input.current
    if (node && !ime.isComposing() && draft !== shown.current && node.value !== draft) {
      node.value = draft
    }
    shown.current = draft
  }, [draft, ime])

  const field = useRef<HTMLDivElement | null>(null)
  const reply = useBotItemReplyMark(
    box,
    field,
    question ?? null,
    scopeKey,
    replyMark,
    onShowQuestion
  )
  const images = attachments.imageAttachments
  const leads = !reply.quote && images.length + mentions.notices.length === 0
  const layout = useBotItemCommentStacked(draft, field, reply.crowded, leads)
  const caretToEnd = useBotItemCommentBoxHandle(ref, {
    scopeKey,
    input: () => input.current,
    composer,
    reply,
    setDraft
  })
  // The thumbnails' order numbers their pills, as in chat.
  const imageRow = useMemo(() => images.map(({ id }) => id), [images])
  const pending = images.some((image) => image.pending) || attachments.pastedTextSaving
  const empty = !draft.trim() && images.length === 0
  const send = (): void => {
    if (empty || pending || mentions.sendHeld) {
      return
    }
    if (!admitNativeChatPastedText(scopeKey, draft, setNotice)) {
      return
    }
    const submitted = readNativeChatComposerDraft(scopeKey)
    const sent = images.filter((image) => image.path)
    // Chips become the [Image #N] of the images sent, as chat numbers them.
    const text = imageReferencesToPromptMarkers(
      projectNativeChatPastedText(draft, submitted.pastedTextFiles),
      sent.map((image) => image.id)
    ).trim()
    const paths = sent.map((image) => image.path)
    const skills = commentSkills(text, submitted.document)
    if (!skills) {
      return
    }
    // Refused, the comment stays in the box, saying why.
    const limit = onSend(text, paths, reply.quote?.id ?? null, skills)
    if (limit) {
      setNotice(botItemHeldAnswersLimitNotice(t, limit))
      return
    }
    if (clearNativeChatComposerDraftIfUnchanged(scopeKey, submitted)) {
      attachments.clearImageAttachments()
    }
    setNotice(null)
  }
  // Stable identities let the memoized editor skip the per-keystroke render, as in chat.
  const editorChange = useLatestHandler((node: NativeChatComposerInput) => {
    shown.current = node.value
    events.onDraftChange(node.value, node)
  })
  const editorSelect = useLatestHandler(events.onTextareaSelect)
  const editorPaste = useLatestHandler(handlePaste)
  // Chat's keys: the `@` and `/` lists' arrows and picks, Enter sends, Shift+Enter adds a line.
  const keyDown = useNativeChatComposerKeyDown({
    autocomplete: mentions.autocomplete,
    mentionFiles: mentions.mentionFiles,
    completeMention: mentions.chooseMention,
    mentionKey: mentions.handleKey,
    activeSuggestion,
    draft,
    hasAttachments: images.length > 0,
    isComposing: ime.isComposing,
    completePickerItem: picker.completeItem,
    dispatchPickerCommand: picker.completeItem,
    dismissPicker: picker.dismiss,
    interrupt: undefined,
    send: () => send(),
    setActiveSuggestion: picker.navigateSuggestion,
    setDraft,
    setCaret
  })
  const editorKeyDown = useLatestHandler((event: React.KeyboardEvent<HTMLDivElement>) => {
    // An empty box leaves Escape to the item pane, which goes back; with text or a list open it stays.
    if (event.key === 'Escape' && empty && mentions.autocomplete.mode === 'none') {
      return
    }
    // An IME's composing Enter commits its text, never the comment.
    if (!ime.ownsKeyDown(event)) {
      keyDown(event)
    }
  })
  const settle = (): void => {
    if (input.current) {
      events.onImeSettled(input.current)
    }
  }
  const editorCompositionStart = useLatestHandler(() => ime.setComposing(true))
  const editorCompositionEnd = useLatestHandler(() => {
    ime.setComposing(false)
    settle()
  })
  const editorBlur = useLatestHandler(() => {
    const composing = ime.isComposing()
    ime.reset()
    if (composing) {
      settle()
    }
  })
  const focusAtEnd = (event: React.MouseEvent<HTMLDivElement>): void => {
    const target = event.target
    const control =
      target instanceof Element
        ? target.closest(
            '[contenteditable], textarea, button, a, input, select, [role="button"], [tabindex]'
          )
        : null
    if (
      !input.current ||
      // Only controls inside the card keep the click; the item pane around it is focusable too.
      (control && event.currentTarget.contains(control)) ||
      window.getSelection()?.toString()
    ) {
      return
    }
    caretToEnd()
  }
  return (
    // Click-to-focus for the padding; the editor itself stays the keyboard target.
    // The chat composer's surface: attach, the text, then mic and send at its foot.
    <NativeChatComposerRoomProvider mentions={mentions}>
      <div
        ref={box}
        data-native-chat-composer-scope={scopeKey}
        onClick={focusAtEnd}
        className={cn(
          'mx-3 mb-3 mt-2 flex shrink-0 cursor-text flex-col rounded-xl border border-chat-composer-border bg-chat-composer-surface p-2 shadow-xs',
          reply.glowing && 'native-chat-composer-glow'
        )}
      >
        <NativeChatComposerMenus
          autocomplete={mentions.autocomplete}
          mention={mentions.listed}
          activeIndex={mentions.activeIndex ?? activeSuggestion}
          listboxId={picker.listboxId}
          onChooseItem={picker.completeItem}
          onRetrySkills={picker.retrySkills}
          onChooseMention={mentions.chooseMention}
        />
        <NativeChatComposerNotices notices={mentions.notices} className="mb-1.5" />
        <BotItemReplyingTo mark={reply} />
        {images.length > 0 ? (
          // Two rows (fewer in a short pane), then they scroll; on the chip's and text's edge, rings and × in view.
          <div className="scrollbar-sleek mb-1.5 flex max-h-[min(128px,14cqh)] flex-wrap gap-2 -ml-0.5 overflow-y-auto pb-0.5 pl-0.5 pr-2 pt-2">
            {images.map((attachment, index) => (
              <NativeChatImageAttachmentPreview
                key={attachment.id}
                attachment={attachment}
                hostEnvironmentId={attachTo?.runtimeEnvironmentId ?? undefined}
                number={index + 1}
                onRemove={attachments.removeImageAttachment}
              />
            ))}
          </div>
        ) : null}
        <div className={cn('flex flex-wrap items-end gap-0.5', nav && BOT_ITEM_TOOL_ROW_TOUCH_FIT)}>
          {access.session ? <NativeChatAttachButton onAttach={fileDrops.pickAttachments} /> : null}
          <div ref={field} className={cn('min-w-0 flex-1', layout.slot)}>
            <NativeChatPromptEditor
              key={scopeKey}
              scopeKey={scopeKey}
              imageRow={imageRow}
              inputRef={input}
              isComposing={ime.isComposing}
              initialValue={draft}
              disabled={false}
              aria-label={t('bots.items.comment.label', 'Comment')}
              aria-expanded={mentions.autocomplete.mode !== 'none'}
              aria-controls={mentions.autocomplete.mode !== 'none' ? picker.listboxId : undefined}
              placeholder={reply.placeholder}
              onChange={editorChange}
              onSelect={editorSelect}
              onPasteCapture={editorPaste}
              onKeyDownCapture={editorKeyDown}
              onCompositionStart={editorCompositionStart}
              onCompositionEnd={editorCompositionEnd}
              onBlur={editorBlur}
              className={cn(
                'scrollbar-sleek block overflow-y-auto bg-transparent py-1.5 text-[13px] leading-5 text-chat-foreground-strong outline-none [&_p.is-editor-empty:only-child]:before:!h-auto [&_p.is-editor-empty:only-child]:before:mr-[-100%] [&_p.is-editor-empty:only-child]:before:w-full [&_p.is-editor-empty:only-child]:before:truncate',
                layout.inset,
                layout.height
              )}
            />
          </div>
          {/* The buttons' height, so the arrows center on + and send rather than on their trimmed margins. */}
          {nav ? (
            <div className={cn('flex h-8 min-w-0 items-center pointer-coarse:h-11', layout.arrows)}>
              {nav}
            </div>
          ) : null}
          <span className="ml-auto flex shrink-0">
            <NativeChatDictationButton
              disabled={dictation.dictationDisabled}
              isDictating={dictation.isDictating}
              isHoldMode={dictation.isDictationHoldMode}
              onToggle={dictation.toggleDictation}
              onHoldStart={dictation.startHoldDictation}
              onHoldEnd={dictation.stopHoldDictation}
            />
          </span>
          <NativeChatComposerPrimaryButton
            aria-label={t('bots.items.comment.submit', 'Comment')}
            disabled={empty || pending || mentions.sendHeld}
            onClick={send}
          >
            <ArrowUp className="size-4" />
          </NativeChatComposerPrimaryButton>
        </div>
      </div>
    </NativeChatComposerRoomProvider>
  )
}
