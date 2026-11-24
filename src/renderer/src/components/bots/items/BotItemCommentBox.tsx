// The item view's comment box: chat's prompt editor and attachment pieces. Idle and empty it is one
// compact row (text and send), so Activity keeps the pane; with focus or anything in it, the text has its
// own row above the tools (attach, the arrows, mic, send). While the agent's question waits, "Replying
// to" names it above the text. Enter sends, Shift+Enter
// adds a line; images paste, drop or attach as thumbnails with an "Image #N" pill at the caret, other
// files as `@path` pills. Uploads go to the item's chat on the bot's host, which then holds them as its own.
import {
  use,
  useCallback,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type Ref
} from 'react'
import { ArrowUp } from 'lucide-react'
import { useTranslate } from '@/i18n/use-translate'
import { useLatestHandler } from '@/lib/use-latest-handler'
import { useImeEnterGestureOwnership } from '@/lib/text-input/ime/ime-composition-keyboard-event'
import { NativeChatComposerPrimaryButton } from '../../native-chat/composer/controls/NativeChatComposerPrimaryButton'
import { NativeChatAttachButton } from '../../native-chat/composer/controls/NativeChatAttachButton'
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
import { composerQuoteTarget } from '../../native-chat/selection-quotes/NativeChatSelectionQuote'
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
import type { Bot } from '../../../../../shared/bot-types'
import { BOT_ITEM_LIMITS, type BotItem } from '../../../../../shared/bots/bot-items'
import { botItemCommentDraftScope } from './bot-item-comment-draft'
import { useKeepFloatingTerminalTriggerClear } from '../../floating-terminal/trigger/floating-terminal-trigger-keep-clear'
import { BOT_ITEM_TOOL_ROW_TOUCH_FIT, BotItemSteppingContext } from './BotItemStepper'
import {
  BotItemReplyingTo,
  useBotItemReplyMark,
  type BotItemWaitingQuestion
} from './BotItemReplyingTo'
import { cn } from '@/lib/class-names'
import { useBotItemCommentCompact } from './use-bot-item-comment-compact'
import { BotItemCommentMic, isBotItemCommentPaddingClick } from './bot-item-comment-box-parts'
import { BotItemCommentRoom, useBotItemCommentPickers } from './bot-item-comment-pickers'
import type { useBotItemQuestionSteps } from './use-bot-item-question-steps'
import {
  useBotItemCommentAttachments,
  type BotItemCommentAttachTarget
} from './use-bot-item-comment-attachments'

export type BotItemCommentBoxHandle = ReturnType<typeof composerQuoteTarget> & {
  focus: () => void
  /** Focus the box with the caret after its text, as when coming back to a draft. */
  focusEnd: () => void
  /** Focus the box and type `text` at its caret. */
  type: (text: string) => void
  /** Put `text` in the box in place of its words, to add to before sending; `plain`: as a comment
   *  of its own, with "Replying to" hidden; else as the answer, naming the question. */
  fill: (text: string, plain?: boolean) => void
  /** Focus the box to answer the waiting question in your own words: it glows once, naming it. */
  answer: () => void
}

const NO_TARGET = () => null

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
  onShowQuestion,
  describedBy,
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
  /** Brings the comment that asks the question into view, by its event id. */
  onShowQuestion?: (eventId: string) => void
  /** The item pane's previous / next arrows, between the attach and mic buttons. */
  nav?: React.ReactNode
  /** The Activity entry this comment would answer, read with the box once the pill led there. */
  describedBy?: string
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
  const { session, blocked } = useBotItemCommentAttachments(bot, item, attachTo)
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
    structuredWorktreeId: session ? attachTo?.worktreeId : undefined,
    structuredSession: session ?? undefined,
    disabled: !session || hidden,
    attachResolvedPaths: attachments.attachResolvedPaths,
    pendingChips: attachments.pendingChips,
    setNotice
  })
  const { resolveAttachmentOwner: ownerOfSession } = fileDrops
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
    targetKey: JSON.stringify([scopeKey, session?.sessionId]),
    disabled: false,
    resolveAttachmentOwner,
    attachResolvedPaths: attachments.attachResolvedPaths,
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

  const reply = useBotItemReplyMark(box, question ?? null, scopeKey, onShowQuestion)
  const images = attachments.imageAttachments
  const pending = images.some((image) => image.pending) || attachments.pastedTextSaving
  const empty = !draft.trim() && images.length === 0
  // Idle and empty, the box is one row (its "Replying to" above it); it opens to the full box with focus,
  // and stays open while it holds anything.
  const { compact, handlers: compactHandlers } = useBotItemCommentCompact(
    box,
    draft.length > 0 ||
      images.length > 0 ||
      pending ||
      dictation.isDictating ||
      mentions.autocomplete.mode !== 'none',
    use(BotItemSteppingContext)
  )
  // One line growing to six, then it scrolls (an answer to a question, eleven); a short pane caps it
  // (`cqh` is the item pane's height), so Activity and Send stay in view.
  const height = reply.quote ? 'max-h-[min(232px,25cqh)]' : 'max-h-[min(132px,25cqh)]'
  const caretToEnd = (): void => {
    const node = input.current
    node?.focus()
    node?.setSelectionRange(node.value.length, node.value.length)
  }
  useImperativeHandle(ref, () => ({
    focus: () => input.current?.focus(),
    focusEnd: caretToEnd,
    ...composerQuoteTarget(composer),
    type: (typed) => void composer.current?.insertTypedText(typed),
    answer: () => {
      reply.show()
      composer.current?.focus({ caretAtEnd: true, glow: true })
    },
    fill: (text, plain) => {
      const mark = plain ? reply.hide : reply.show
      mark()
      setDraft(`${text} `)
      if (input.current) {
        input.current.value = `${text} `
      }
      caretToEnd()
    }
  }))
  // The thumbnails' order numbers their pills, as in chat.
  const imageRow = useMemo(() => images.map(({ id }) => id), [images])
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
    if (clearNativeChatComposerDraftIfUnchanged(scopeKey, submitted)) {
      attachments.clearImageAttachments()
    }
    setNotice(null)
    onSend(text, paths, reply.quote?.id ?? null, skills)
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
  const settle = () => input.current && events.onImeSettled(input.current)
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
    if (input.current && isBotItemCommentPaddingClick(event)) {
      caretToEnd()
    }
  }
  return (
    // Click-to-focus for the padding; the editor itself stays the keyboard target.
    // The chat composer's surface: attach, the text, then mic and send at its foot.
    <NativeChatComposerRoomProvider mentions={mentions}>
      <div
        ref={box}
        data-native-chat-composer-scope={scopeKey}
        onClick={focusAtEnd}
        {...compactHandlers}
        data-bot-item-comment=""
        data-compact={compact || undefined}
        className={cn(
          'mx-3 mb-3 mt-2 flex shrink-0 cursor-text flex-col rounded-xl border border-chat-composer-border bg-chat-composer-surface px-1.5 shadow-xs',
          // The text starts at the same place compact or open.
          compact ? 'py-1' : 'pb-1.5 pt-1',
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
          // Two rows of chips (fewer in a short pane), then they scroll; the padding keeps rings and × in view.
          <div className="scrollbar-sleek mb-1.5 flex max-h-[min(128px,14cqh)] flex-wrap gap-2 overflow-y-auto px-1 pb-0.5 pr-2 pt-2">
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
          {/* Open, the text has its own row whatever its length, so the tools never shift it. */}
          <div className={cn('min-w-0 flex-1', !compact && 'basis-full')}>
            <NativeChatPromptEditor
              key={scopeKey}
              scopeKey={scopeKey}
              imageRow={imageRow}
              inputRef={input}
              isComposing={ime.isComposing}
              initialValue={draft}
              disabled={false}
              aria-label={t('bots.items.comment.label', 'Comment')}
              aria-describedby={describedBy}
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
              className={`scrollbar-sleek block overflow-y-auto bg-transparent px-1 py-1.5 text-sm leading-5 text-chat-foreground-strong outline-none [&_p.is-editor-empty:only-child]:before:!h-auto [&_p.is-editor-empty:only-child]:before:mr-[-100%] [&_p.is-editor-empty:only-child]:before:w-full [&_p.is-editor-empty:only-child]:before:truncate min-h-8 ${height}`}
            />
          </div>
          {compact ? null : (
            <>
              {session ? <NativeChatAttachButton onAttach={fileDrops.pickAttachments} /> : null}
              {nav}
              <BotItemCommentMic dictation={dictation} />
            </>
          )}
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
