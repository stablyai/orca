// The item view's comment box: chat's prompt editor and attachment pieces in one growing row (attach,
// text, mic, send); while the agent's question waits, "Replying to" names it. Enter sends, Shift+Enter adds a line;
// images paste, drop or attach as thumbnails with an "Image #N" pill at the caret, other files as `@path`
// pills. Uploads go to the item's chat on the bot's host, which then holds them as its own.
import {
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
import { NativeChatDictationButton } from '../../native-chat/composer/controls/NativeChatDictationButton'
import { useNativeChatDictation } from '../../native-chat/composer/editor/use-native-chat-dictation'
import { NativeChatComposerNotices } from '../../native-chat/composer/controls/NativeChatComposerNotices'
import { useNativeChatComposerNotice } from '../../native-chat/composer/controls/use-native-chat-composer-notice'
import { NativeChatPromptEditor } from '../../native-chat/composer/editor/NativeChatPromptEditor'
import { useNativeChatComposerKeyDown } from '../../native-chat/composer/editor/use-native-chat-composer-keydown'
import { NativeChatMentionMenu } from '../../native-chat/composer/pickers/NativeChatAutocompleteMenus'
import { useNativeChatPickerState } from '../../native-chat/composer/pickers/use-native-chat-picker-state'
import { useNativeChatComposerMentions } from '../../native-chat/native-chat-composer-room'
import type { ComposerAutocomplete } from '../../../../../shared/native-chat/input/composer/native-chat-composer-autocomplete'
import type { SlashCommandSuggestion } from '../../../../../shared/native-chat/input/commands/native-chat-slash-commands'
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
import type { Bot } from '../../../../../shared/bot-types'
import { BOT_ITEM_LIMITS, type BotItem } from '../../../../../shared/bots/bot-items'
import { botRefKey } from '@/lib/bot-hosts'
import { useKeepFloatingTerminalTriggerClear } from '../../floating-terminal/trigger/floating-terminal-trigger-keep-clear'
import { BOT_ITEM_TOOL_ROW_TOUCH_FIT } from './BotItemStepper'
import {
  BotItemReplyingTo,
  useBotItemReplyMark,
  type BotItemWaitingQuestion
} from './BotItemReplyingTo'
import { cn } from '@/lib/class-names'
import {
  useBotItemCommentAttachments,
  type BotItemCommentAttachTarget
} from './use-bot-item-comment-attachments'

export type BotItemCommentBoxHandle = {
  focus: () => void
  /** Focus the box with the caret after its text, as when coming back to a draft. */
  focusEnd: () => void
  /** Focus the box and type `text` at its caret. */
  type: (text: string) => void
  /** Put `text` in the box in place of its words, to add to before sending; `plain`: as a comment
   *  of its own, with "Replying to" hidden. */
  fill: (text: string, plain?: boolean) => void
  /** Focus the box to answer the waiting question in your own words: it glows once, naming it. */
  answer: () => void
  /** The waiting question "Replying to" names, by its id; null once hidden. */
  replyingTo: () => string | null
}

const NO_TARGET = () => null
const NO_COMMANDS: readonly SlashCommandSuggestion[] = []
const NO_PICK = () => {}
const CLOSED: ComposerAutocomplete = { mode: 'none' }

export function BotItemCommentBox({
  bot,
  item,
  attachTo,
  onSend,
  hidden = false,
  nav,
  question,
  ref
}: {
  bot: Bot
  item: BotItem
  /** The bot's folder workspace and host, which file drops and uploads resolve against. */
  attachTo: BotItemCommentAttachTarget | null
  /** Takes the comment as the box empties: it shows and goes to the host from there. */
  onSend: (text: string, paths: readonly string[]) => void
  /** Not on screen: files dropped on the pane are not taken into its hidden draft. */
  hidden?: boolean
  /** The agent's question the item waits on: its first line, and whether it gave quick replies. */
  question?: BotItemWaitingQuestion | null
  /** The item pane's previous / next arrows, between the attach and mic buttons. */
  nav?: React.ReactNode
  ref?: Ref<BotItemCommentBoxHandle>
}): React.JSX.Element {
  const t = useTranslate()
  const scopeKey = `bot-item-comment:${botRefKey(bot)}:${item.uid}`
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
  // Chat's picker and `@` list: workspace files from the bot's folder. A comment runs no commands,
  // so only the `@` menu opens.
  const picker = useNativeChatPickerState({
    agent: bot.agent,
    terminalTabId: scopeKey,
    draftScopeKey: scopeKey,
    draft,
    caret,
    agentCommands: NO_COMMANDS,
    recalledFromHistory: false,
    disabled: false,
    isComposing: ime.isComposing,
    textareaRef: input,
    setDraft,
    setCaret,
    setActiveSuggestion
  })
  const mentionPicker = useMemo(
    () => ({
      autocomplete: picker.autocomplete.mode === 'mention' ? picker.autocomplete : CLOSED,
      completeMention: picker.completeMention
    }),
    [picker.autocomplete, picker.completeMention]
  )
  const mentions = useNativeChatComposerMentions(undefined, draft, mentionPicker, {
    terminalTabId: scopeKey,
    structuredWorktreeId: attachTo?.worktreeId,
    caret
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

  const reply = useBotItemReplyMark(box, question ?? null, scopeKey)
  const caretToEnd = (): void => {
    const node = input.current
    node?.focus()
    node?.setSelectionRange(node.value.length, node.value.length)
  }
  useImperativeHandle(ref, () => ({
    focus: () => input.current?.focus(),
    focusEnd: caretToEnd,
    type: (typed) => void composer.current?.insertTypedText(typed),
    replyingTo: () => reply.quote?.id ?? null,
    answer: () => {
      reply.show()
      composer.current?.focus({ caretAtEnd: true, glow: true })
    },
    fill: (text, plain) => {
      if (plain) {
        reply.hide()
      }
      setDraft(`${text} `)
      if (input.current) {
        input.current.value = `${text} `
      }
      caretToEnd()
    }
  }))
  const images = attachments.imageAttachments
  // The thumbnails' order numbers their pills, as in chat.
  const imageRow = useMemo(() => images.map(({ id }) => id), [images])
  const pending = images.some((image) => image.pending) || attachments.pastedTextSaving
  const empty = !draft.trim() && images.length === 0
  const send = (): void => {
    if (empty || pending) {
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
    if (clearNativeChatComposerDraftIfUnchanged(scopeKey, submitted)) {
      attachments.clearImageAttachments()
    }
    setNotice(null)
    onSend(text, paths)
  }
  // Stable identities let the memoized editor skip the per-keystroke render, as in chat.
  const editorChange = useLatestHandler((node: NativeChatComposerInput) => {
    shown.current = node.value
    events.onDraftChange(node.value, node)
  })
  const editorSelect = useLatestHandler(events.onTextareaSelect)
  const editorPaste = useLatestHandler(handlePaste)
  // Chat's keys: the `@` list's arrows and picks, Enter sends, Shift+Enter adds a line.
  const keyDown = useNativeChatComposerKeyDown({
    autocomplete: mentions.autocomplete,
    mentionFiles: mentions.mentionFiles,
    completeMention: mentions.chooseMention,
    mentionKey: mentions.handleKey,
    activeSuggestion,
    draft,
    hasAttachments: images.length > 0,
    isComposing: ime.isComposing,
    completePickerItem: NO_PICK,
    dispatchPickerCommand: NO_PICK,
    dismissPicker: picker.dismiss,
    interrupt: undefined,
    send: () => send(),
    setActiveSuggestion: picker.navigateSuggestion,
    setDraft,
    setCaret
  })
  const editorKeyDown = useLatestHandler((event: React.KeyboardEvent<HTMLDivElement>) => {
    // An empty box leaves Escape to the item pane, which goes back; with text or an `@` list it stays.
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
    const node = input.current
    const target = event.target
    const control =
      target instanceof Element
        ? target.closest(
            '[contenteditable], textarea, button, a, input, select, [role="button"], [tabindex]'
          )
        : null
    if (
      !node ||
      // Only controls inside the card keep the click; the item pane around it is focusable too.
      (control && event.currentTarget.contains(control)) ||
      window.getSelection()?.toString()
    ) {
      return
    }
    node.focus()
    node.setSelectionRange(node.value.length, node.value.length)
  }
  return (
    // Click-to-focus for the padding; the editor itself stays the keyboard target.
    // The chat composer's surface, in one row: attach, the text, then mic and send at its foot.
    <div
      ref={box}
      data-native-chat-composer-scope={scopeKey}
      onClick={focusAtEnd}
      className={cn(
        'mx-3 mb-3 mt-2 flex shrink-0 cursor-text flex-col rounded-xl border border-chat-composer-border bg-chat-composer-surface p-1.5 shadow-xs',
        reply.glowing && 'native-chat-composer-glow'
      )}
    >
      {mentions.autocomplete.mode === 'mention' ? (
        <NativeChatMentionMenu
          mention={mentions.listed}
          activeIndex={mentions.activeIndex ?? activeSuggestion}
          listboxId={picker.listboxId}
          onChoose={mentions.chooseMention}
        />
      ) : null}
      <NativeChatComposerNotices notices={notices} className="mb-1.5" />
      {reply.quote ? <BotItemReplyingTo question={reply.quote.line} onHide={reply.hide} /> : null}
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
      <div className={cn('flex items-end gap-0.5', nav ? BOT_ITEM_TOOL_ROW_TOUCH_FIT : null)}>
        {access.session ? <NativeChatAttachButton onAttach={fileDrops.pickAttachments} /> : null}
        <div className="min-w-0 flex-1">
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
            // One row, growing to six lines (less in a short pane: `cqh`), then it scrolls.
            className="scrollbar-sleek block max-h-[min(132px,25cqh)] min-h-8 overflow-y-auto bg-transparent px-1 py-1.5 text-sm leading-5 text-chat-foreground-strong outline-none [&_p.is-editor-empty:only-child]:before:!h-auto [&_p.is-editor-empty:only-child]:before:mr-[-100%] [&_p.is-editor-empty:only-child]:before:w-full [&_p.is-editor-empty:only-child]:before:truncate"
          />
        </div>
        {nav}
        <span className="flex shrink-0">
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
          disabled={empty || pending}
          onClick={send}
        >
          <ArrowUp className="size-4" />
        </NativeChatComposerPrimaryButton>
      </div>
    </div>
  )
}
