// BotItemPane holds it under the back row and sends typing from anywhere in it to the comment box.
// The comment box always stays at the bottom: a reply to the agent's question is a comment, typed there
// or picked from the question's quick replies.
import { useDeferredValue, useEffect, useMemo, useRef } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { useLatestHandler } from '@/lib/use-latest-handler'
import { useTranslate } from '@/i18n/use-translate'
import { useAppStore } from '@/store'
import { selectFocusedTab } from '@/lib/focused-chat-workers'
import { folderWorkspaceKey } from '../../../../../shared/workspace/identity/workspace-scope'
import { runtimeTargetEnvironmentId } from '@/runtime/rpc/targets/runtime-client-target'
import type { Bot } from '../../../../../shared/bot-types'
import type { BotItem, BotItemStatus } from '../../../../../shared/bots/bot-items'
import { useBotItemQuestionSteps } from './use-bot-item-question-steps'
import { NativeChatJumpToLatest } from '../../native-chat/viewport/scroll/NativeChatJumpToLatest'
import { NativeChatPaneFileDropSurface } from '../../native-chat/attachments/intake/NativeChatPaneFileDropSurface'
import {
  NativeChatMarkdownImageOwnerContext,
  type NativeChatMarkdownImageOwner
} from '../../native-chat/media/images/native-chat-markdown-image-owner'
import { NativeChatTextAttachmentScope } from '../../native-chat/media/text/NativeChatTextAttachments'
import { botErrorMessage } from '../bot-presentation'
import { openBotSession } from '../bot-session-open'
import { useBotTranscriptFollow } from '../use-bot-transcript-follow'
import { useBotGroupFileContexts } from '../BotGroupTranscriptOwner'
import { LinkActionPopover } from '@/components/link-actions/LinkActionPopover'
import { NativeChatFileLinkExistenceContext } from '../../native-chat/links/actions/native-chat-file-link-existence'
import { NativeChatLinkClickContext } from '../../native-chat/links/actions/native-chat-link-click-context'
import { useNativeChatLinkActions } from '../../native-chat/links/actions/use-native-chat-link-actions'
import { BotItemActivityList } from './BotItemActivityList'
import { useBotItemStatusNotes } from './BotItemStatusNoteDialog'
import { BotItemClampedText } from './BotItemClampedText'
import { BotItemCommentBox, type BotItemCommentBoxHandle } from './BotItemCommentBox'
import { NativeChatSelectionQuote } from '../../native-chat/selection-quotes/NativeChatSelectionQuote'
import { revealBotItemComment } from './bot-item-comment-reveal'
import { BotItemHeader } from './BotItemHeader'
import { useBotItemNeedsYouJump } from './BotItemReplyJump'
import { setBotItemsStatus } from './use-bot-items'
import { useBotItemSnoozing } from './BotItemSnooze'
import { useBotItemView, useWaitingQuestionPage, type BotItemViewRead } from './use-bot-item-view'
import { useBotItemPendingComments } from './use-bot-item-pending-comments'
import { BotItemsReadFailed } from './BotItemsReadFailed'
import { BotItemNavRow } from './BotItemStepper'
import { BotItemLoading } from './BotItemLoading'
import { BotItemCloseNote, BotItemDoneWhen } from './BotItemCloseNote'
import { BotItemLinksBlock } from './BotItemLinks'
import { BotItemMarkdown } from './BotItemMarkdown'
import { BotItemFrom } from './BotItemFrom'
import { BotItemDetailsScroller, useBotItemActivityTopFade } from './bot-item-details-scroll'

const NO_FOLDERS: never[] = []

export function BotItemView({
  bot,
  uid,
  listed,
  takeFocus,
  commentRef,
  statusSlot,
  nav,
  onShown,
  onLoading,
  onGone
}: {
  bot: Bot
  uid: string
  listed?: BotItem
  commentRef?: React.RefObject<BotItemCommentBoxHandle | null>
  /** Where the status menu goes: the pane's back row. */
  statusSlot?: HTMLElement | null
  /** Whether the item should take focus as it shows (nothing else in the pane holds it). */
  takeFocus?: () => boolean
  /** The previous / next arrows, for the comment box's tool row. */
  nav?: React.ReactNode
  /** Called once, when the item first shows. */
  onShown?: (item: BotItem) => void
  onLoading?: () => (() => void) | undefined
  onGone?: (uid: string) => void
}): React.JSX.Element {
  const view = useBotItemView(bot, uid, listed)
  const { deleted, item } = view
  useEffect(() => {
    if (deleted) {
      onGone?.(uid)
    }
  }, [deleted, onGone, uid])
  // Once per mount (the view is keyed by item), and once under a replayed effect too.
  const told = useRef(false)
  useEffect(() => {
    if (item && !told.current) {
      told.current = true
      onShown?.(item)
    }
    return !item && !view.failed && !deleted ? onLoading?.() : undefined
  }, [item, onShown, view.failed, deleted, onLoading])
  if (!item) {
    return (
      <BotItemUnread takeFocus={takeFocus} failed={view.failed} deleted={deleted} nav={nav}>
        {deleted ? <BotItemDeletedNotice /> : null}
        {view.failed ? <BotItemsReadFailed onRetry={view.retry} /> : null}
        {!view.failed && !deleted ? <BotItemLoading /> : null}
      </BotItemUnread>
    )
  }
  return (
    <BotItemBody
      bot={bot}
      view={view}
      item={item}
      notice={deleted ? <BotItemDeletedNotice /> : null}
      deleted={deleted}
      takeFocus={takeFocus}
      commentRef={commentRef}
      statusSlot={statusSlot}
      nav={nav}
    />
  )
}

/** No item to show yet (reading, or the read failed): the arrows still sit at the bottom, and it holds
 *  focus a removed control (Retry) dropped. */
function BotItemUnread({
  takeFocus,
  failed,
  deleted,
  nav,
  children
}: {
  takeFocus?: () => boolean
  failed: boolean
  deleted: boolean
  nav?: React.ReactNode
  children: React.ReactNode
}): React.JSX.Element {
  const pane = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    if (takeFocus?.()) {
      pane.current?.focus({ preventScroll: true })
    }
  }, [takeFocus, failed, deleted])
  return (
    <div
      ref={pane}
      tabIndex={-1}
      data-bot-item-focus-home=""
      className="flex min-h-0 flex-1 flex-col outline-none"
    >
      {children}
      {nav ? <BotItemNavRow nav={nav} /> : null}
    </div>
  )
}

export function BotItemDeletedNotice(): React.JSX.Element {
  const t = useTranslate()
  return (
    <p role="status" className="px-2 py-1.5 text-xs text-muted-foreground">
      {t('bots.items.view.deleted', 'This item was deleted.')}
    </p>
  )
}

/** The open item, from a read the caller owns. */
export function BotItemBody({
  bot,
  view,
  item,
  notice,
  deleted = false,
  takeFocus,
  commentRef,
  statusSlot,
  nav
}: {
  bot: Bot
  view: BotItemViewRead
  item: BotItem
  notice?: React.ReactNode
  /** Gone from the host: shown as last read, with no status or comment. */
  deleted?: boolean
  takeFocus?: () => boolean
  /** Where the comment box's handle goes, for the pane's type-to-focus. */
  commentRef?: React.RefObject<BotItemCommentBoxHandle | null>
  /** Where the status menu goes; without one the header gives it a row of its own. */
  statusSlot?: HTMLElement | null
  /** The previous / next arrows, for the comment box's tool row. */
  nav?: React.ReactNode
}): React.JSX.Element {
  const t = useTranslate()
  const snoozing = useBotItemSnoozing(bot)
  const pane = useRef<HTMLDivElement | null>(null)
  const ownComment = useRef<BotItemCommentBoxHandle | null>(null)
  const comment = commentRef ?? ownComment
  // Shown on open or a step: typing then reaches the comment box without a click. Deleted, its comment box
  // goes, and focus it held comes here.
  useEffect(() => {
    if (takeFocus?.()) {
      const back = pane.current
        ?.closest('[data-bot-item-pane]')
        ?.querySelector<HTMLButtonElement>('[data-bot-item-back]')
      ;(back ?? pane.current)?.focus({ preventScroll: true })
    }
  }, [takeFocus, deleted])
  const chatTitle =
    item.chat.kind === 'home'
      ? t('bots.items.homeChat', 'Home Chat')
      : (item.chat.title ?? t('bots.items.chatFallback', 'Chat'))
  const setStatus = (to: BotItemStatus, reason?: string): void =>
    void setBotItemsStatus(bot, [item.uid], to, reason).catch((error: unknown) =>
      toast.error(botErrorMessage(error))
    )
  const notes = useBotItemStatusNotes((_items, to, note) => setStatus(to, note))
  const pending = useBotItemPendingComments(bot, item.uid, view.events)
  // The header and comment box paint first; the Activity, the costly part, renders right after.
  const activityMounted = useDeferredValue(true, false)
  const activityShown = view.eventsRead && activityMounted
  const { scrollRef, contentRef, scrollerProps, showJump, jumpToLatest, revealRow } =
    useBotTranscriptFollow({
      itemCount: view.events.length + pending.shown.length,
      isWorking: false,
      isVisible: true,
      preserveReaderOnViewportResize: true
    })
  // From the comment box or a quick reply: shown at once, then sent to the host.
  const sendComment: Parameters<typeof useBotItemQuestionSteps>[3] = (
    text,
    paths = [],
    ...rest
  ) => {
    pending.send(text, paths, view.events.at(-1)?.id ?? item.lastEventId, ...rest)
    jumpToLatest()
  }
  const sendLatest = useLatestHandler(sendComment)
  // Comment and description links open as in chat, from the bot's folder; the panel has no tab of
  // its own, so opens place beside the bot workspace's focused tab, as a click in that chat would.
  const sourceTabId = useAppStore(
    (state) => selectFocusedTab(state, folderWorkspaceKey(bot.folderWorkspaceId))?.id ?? ''
  )
  const fileContext = useBotGroupFileContexts(NO_FOLDERS, bot, sourceTabId).get(bot.id)
  const runtimeContext = fileContext?.runtimeContext
  const attachTo = useMemo(
    () =>
      runtimeContext?.worktreeId
        ? {
            worktreeId: runtimeContext.worktreeId,
            runtimeEnvironmentId: runtimeTargetEnvironmentId(runtimeContext.target)
          }
        : null,
    [runtimeContext]
  )
  const imageOwner = useMemo(
    (): NativeChatMarkdownImageOwner => ({
      fileLinkContext: fileContext?.fileLinkContext ?? null,
      runtimeContext: runtimeContext ?? null,
      isVisible: true
    }),
    [fileContext?.fileLinkContext, runtimeContext]
  )
  // `waitingLine`: the question the comment box names, until a reply is on its way.
  const { steps, sent, quick, fromBox, answerNone, waitingLine } = useBotItemQuestionSteps(
    bot,
    item,
    view.events,
    sendLatest,
    pending.shown
  )
  const quickReplies = useMemo(
    () =>
      deleted
        ? undefined
        : {
            send: quick,
            edit: (text: string) => comment.current?.fill(text),
            recover: (text: string) => {
              // A comment of its own: it answers no line, whatever the box names next.
              answerNone()
              comment.current?.fill(text, true)
            },
            type: () => comment.current?.answer(),
            steps,
            sent
          },
    [deleted, comment, quick, answerNone, steps, sent]
  )
  const loadingTarget = useWaitingQuestionPage(item.waitingAsk ?? item.question?.eventId, view)
  const answering = steps?.sending ?? pending.shown.some(({ failed }) => !failed)
  const waitingOn = waitingLine ? { ...waitingLine, asker: item.owner.name ?? bot.name } : null
  const needsYou = useBotItemNeedsYouJump({
    eligible: item.status === 'needs_you' && !deleted && !answering,
    activityShown,
    loadingTarget,
    scrollRef,
    paneRef: pane,
    revealRow,
    comment
  })
  const links = useNativeChatLinkActions(fileContext?.fileLinkContext ?? null, pane, {
    sessionId: null,
    isVisible: true
  })
  const activityFade = useBotItemActivityTopFade(
    scrollerProps.onScroll,
    'scrollbar-sleek min-h-0 flex-1 overflow-y-auto [overflow-anchor:none]'
  )
  return (
    <div
      ref={pane}
      // Clicking the item's text focuses the pane, so typing after it still reaches the box.
      tabIndex={-1}
      data-bot-item-focus-home=""
      className="flex min-h-0 flex-1 flex-col outline-none"
    >
      {notice}
      {view.failed ? <BotItemsReadFailed onRetry={view.retry} /> : null}
      {/* Pasted-text and file pills open their preview from the bot's host; files drop anywhere here. */}
      <NativeChatMarkdownImageOwnerContext value={imageOwner}>
        <NativeChatTextAttachmentScope enabled>
          {/* A size container: the comment box caps its height to a share of this pane's (`cqh`). */}
          <NativeChatPaneFileDropSurface className="flex min-h-0 flex-1 flex-col [container-type:size]">
            <NativeChatFileLinkExistenceContext value={fileContext?.existence ?? null}>
              <NativeChatLinkClickContext value={links.onLinkClick}>
                <div className="relative flex min-h-0 flex-1 flex-col">
                  {/* The pinned title and the details share one cap (BotItemDetailsScroller), so
                      Activity keeps the space it had when the title scrolled with the details. */}
                  <div className="flex min-h-0 shrink-0 flex-col">
                    <BotItemHeader
                      bot={bot}
                      item={item}
                      deleted={deleted}
                      onStatus={(to) => notes.move([item], to)}
                      snoozing={snoozing}
                      reply={needsYou.reply}
                      statusSlot={statusSlot}
                    />
                    <BotItemDetailsScroller>
                      <div className="flex flex-col gap-4 px-3.5 pt-3.5">
                        {item.description ? (
                          <BotItemClampedText
                            text={item.description}
                            clampClassName="line-clamp-3"
                            render={renderDescription}
                          />
                        ) : null}
                        {item.status === 'canceled' || item.status === 'done' ? (
                          <BotItemCloseNote item={item} />
                        ) : null}
                        <BotItemDoneWhen item={item} />
                        <BotItemLinksBlock bot={bot} links={item.links} chat={chatTitle} />
                        <BotItemFrom
                          chat={chatTitle}
                          createdAt={item.createdAt}
                          onOpen={() => openBotSession(bot, item.chat.id)}
                        />
                      </div>
                    </BotItemDetailsScroller>
                  </div>
                  <section className="mt-4 flex min-h-0 flex-1 flex-col">
                    <h3 className="mb-1.5 shrink-0 px-3.5 text-xs text-muted-foreground">
                      {t('bots.items.view.activity', 'Activity')}
                    </h3>
                    <div
                      ref={scrollRef}
                      {...scrollerProps}
                      onScroll={activityFade.onScroll}
                      className={activityFade.className}
                    >
                      <div ref={contentRef} className="px-3.5 pb-2">
                        {view.hasEarlier ? (
                          <Button variant="ghost" size="xs" onClick={view.loadEarlier}>
                            {t('bots.items.view.showEarlier', 'Show earlier')}
                          </Button>
                        ) : null}
                        {/* From the list's row, the Activity shows once read: never a false "No comments". */}
                        {activityShown ? (
                          <BotItemActivityList
                            bot={bot}
                            item={item}
                            events={view.events}
                            pending={pending}
                            quickReplies={quickReplies}
                            needsYou={needsYou.mark}
                          />
                        ) : null}
                      </div>
                    </div>
                  </section>
                  {/* A soft edge over the comment box: activity scrolling under it reads as more below. */}
                  <div
                    aria-hidden
                    className="pointer-events-none absolute inset-x-0 bottom-0 h-4 bg-linear-to-b from-transparent to-sidebar"
                  />
                  <NativeChatJumpToLatest
                    visible={showJump && !needsYou.pointsDown}
                    onJump={jumpToLatest}
                  />
                </div>
              </NativeChatLinkClickContext>
            </NativeChatFileLinkExistenceContext>
            <LinkActionPopover request={links.linkActionRequest} onClose={links.closeLinkActions} />
            <NativeChatSelectionQuote rootRef={pane} composerRef={comment} enabled={!deleted} />
            {deleted ? (
              nav && <BotItemNavRow nav={nav} />
            ) : (
              <BotItemCommentBox
                ref={comment}
                bot={bot}
                item={item}
                attachTo={attachTo}
                nav={nav}
                question={waitingOn}
                describedBy={needsYou.describedBy}
                onShowQuestion={(eventId) =>
                  revealBotItemComment(scrollRef.current, eventId, 'flash')
                }
                onSend={fromBox}
              />
            )}
          </NativeChatPaneFileDropSurface>
        </NativeChatTextAttachmentScope>
      </NativeChatMarkdownImageOwnerContext>
      {notes.dialog}
      {snoozing.dialog}
    </div>
  )
}

/** File paths in the description read as their file name. */
function renderDescription(text: string): React.ReactNode {
  return <BotItemMarkdown text={text} shortFileLinks />
}
