// One item, in the list's place: a frozen header (title, status, links), then the description
// (clamped), chat, done means and activity scrolling under it, and a comment box that wakes its chat.
// BotItemPane holds it under the back row and sends typing from anywhere in it to the comment box.
// The comment box always stays at the bottom: a reply to the agent's question is a comment, typed there
// or picked from the question's quick replies.
import { useDeferredValue, useEffect, useMemo, useRef, useState } from 'react'
import { ExternalLink, House, MessageSquare } from 'lucide-react'
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
import { BotItemCancelDialog } from './BotItemCancelDialog'
import { BotItemClampedText } from './BotItemClampedText'
import { BotItemCommentBox, type BotItemCommentBoxHandle } from './BotItemCommentBox'
import { BotItemHeader } from './BotItemHeader'
import { setBotItemsStatus } from './use-bot-items'
import { useBotItemSnoozing } from './BotItemSnooze'
import { useBotItemView, type BotItemViewRead } from './use-bot-item-view'
import { useBotItemPendingComments } from './use-bot-item-pending-comments'
import { BotItemsReadFailed } from './BotItemsReadFailed'
import { BotItemNavRow } from './BotItemStepper'

const NO_FOLDERS: never[] = []

export function BotItemView({
  bot,
  uid,
  listed,
  takeFocus,
  commentRef,
  nav,
  onShown,
  onGone
}: {
  bot: Bot
  uid: string
  listed?: BotItem
  commentRef?: React.RefObject<BotItemCommentBoxHandle | null>
  /** Whether the item should take focus as it shows (nothing else in the pane holds it). */
  takeFocus?: () => boolean
  /** The previous / next arrows, for the comment box's tool row. */
  nav?: React.ReactNode
  /** Called once, when the item first shows. */
  onShown?: (item: BotItem) => void
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
  }, [item, onShown])
  const notice = deleted ? <BotItemDeletedNotice /> : null
  if (!item) {
    return (
      <BotItemUnread takeFocus={takeFocus} failed={view.failed} deleted={deleted} nav={nav}>
        {notice}
        {view.failed ? <BotItemsReadFailed onRetry={view.retry} /> : null}
      </BotItemUnread>
    )
  }
  return (
    <BotItemBody
      bot={bot}
      view={view}
      item={item}
      notice={notice}
      deleted={deleted}
      takeFocus={takeFocus}
      commentRef={commentRef}
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
  /** The previous / next arrows, for the comment box's tool row. */
  nav?: React.ReactNode
}): React.JSX.Element {
  const t = useTranslate()
  const [canceling, setCanceling] = useState(false)
  const snoozing = useBotItemSnoozing(bot)
  const pane = useRef<HTMLDivElement | null>(null)
  const ownComment = useRef<BotItemCommentBoxHandle | null>(null)
  const comment = commentRef ?? ownComment
  // Shown on open or a step: typing then reaches the comment box without a click. Deleted, its comment box
  // goes, and focus it held comes here.
  useEffect(() => {
    if (takeFocus?.()) {
      pane.current?.focus({ preventScroll: true })
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
  const ChatIcon = item.chat.kind === 'home' ? House : MessageSquare
  const pending = useBotItemPendingComments(bot, item.uid, view.events)
  // The header and comment box paint first; the Activity, the costly part, renders right after.
  const activityMounted = useDeferredValue(true, false)
  const { scrollRef, contentRef, scrollerProps, showJump, jumpToLatest } = useBotTranscriptFollow({
    itemCount: view.events.length + pending.shown.length,
    isWorking: false,
    isVisible: true
  })
  // From the comment box or a quick reply: shown at once, then sent to the host.
  const sendComment = (text: string, paths: readonly string[] = []): void => {
    pending.send(text, paths, view.events.at(-1)?.id ?? item.lastEventId)
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
  const { steps, sent, quick, waitingLine } = useBotItemQuestionSteps(
    bot,
    item,
    view.events,
    sendLatest,
    pending.shown
  )
  // The box's Enter, "Replying to" a line of several questions, answers that line like a quick reply.
  const sendFromBox = (text: string, paths: readonly string[]): void => {
    const line = steps ? `${steps.askId}:${steps.current}` : null
    if (steps && line && paths.length === 0 && comment.current?.replyingTo() === line) {
      steps.answer(steps.current, text)
      return
    }
    sendComment(text, paths)
  }
  const quickReplies = useMemo(
    () =>
      deleted
        ? undefined
        : {
            send: quick,
            edit: (text: string) => comment.current?.fill(text),
            recover: (text: string) => comment.current?.fill(text, true),
            type: () => comment.current?.answer(),
            steps,
            sent
          },
    [deleted, comment, quick, steps, sent]
  )
  // The waiting question's comment, with its words and quick replies, is read even when it is older
  // than the loaded page: earlier pages load until it shows.
  const questionId = item.question?.eventId
  const questionUnread =
    view.eventsRead &&
    questionId !== undefined &&
    !view.events.some((event) => event.id === questionId)
  const { hasEarlier, loadEarlier } = view
  const earliest = view.events[0]?.id
  useEffect(() => {
    if (questionUnread && hasEarlier) {
      loadEarlier()
    }
  }, [questionUnread, hasEarlier, earliest, loadEarlier])
  const waitingOn =
    waitingLine && !pending.shown.some(({ failed }) => !failed)
      ? { ...waitingLine, asker: item.owner.name ?? bot.name }
      : null
  const links = useNativeChatLinkActions(fileContext?.fileLinkContext ?? null, pane, {
    sessionId: null,
    isVisible: true
  })
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
                  <div
                    ref={scrollRef}
                    {...scrollerProps}
                    className="scrollbar-sleek min-h-0 flex-1 overflow-y-auto [overflow-anchor:none]"
                  >
                    <BotItemHeader
                      bot={bot}
                      item={item}
                      chatTitle={chatTitle}
                      deleted={deleted}
                      onStatus={(to) => (to === 'canceled' ? setCanceling(true) : setStatus(to))}
                      snoozing={snoozing}
                      scrollRef={scrollRef}
                    />
                    <div ref={contentRef} className="flex flex-col gap-4 px-3.5 pt-2">
                      {item.description ? (
                        <BotItemClampedText text={item.description} clampClassName="max-h-[57px]" />
                      ) : null}
                      {item.status === 'canceled' || item.status === 'done' ? (
                        <CloseNote item={item} />
                      ) : null}
                      <dl className="grid grid-cols-[84px_minmax(0,1fr)] items-start gap-x-2 gap-y-1 text-xs @max-[284px]:grid-cols-[72px_minmax(0,1fr)]">
                        <dt className="leading-6 text-muted-foreground">
                          {t('bots.items.field.chat', 'Chat')}
                        </dt>
                        <dd className="flex h-6 items-center">
                          <button
                            type="button"
                            className="flex min-w-0 items-center gap-1.5 text-foreground hover:underline"
                            onClick={() => openBotSession(bot, item.chat.id)}
                          >
                            <ChatIcon className="size-3 shrink-0 text-muted-foreground" />
                            <span className="truncate">{chatTitle}</span>
                            <ExternalLink className="size-3 shrink-0 text-muted-foreground" />
                          </button>
                        </dd>
                        {item.doneMeans ? (
                          <>
                            <dt className="leading-[18px] text-muted-foreground">
                              {t('bots.items.field.doneMeans', 'Done means')}
                            </dt>
                            <dd className="leading-[18px] text-foreground">{item.doneMeans}</dd>
                          </>
                        ) : null}
                      </dl>
                      <section className="pb-2">
                        <h3 className="mb-1.5 text-xs text-muted-foreground">
                          {t('bots.items.view.activity', 'Activity')}
                        </h3>
                        {view.hasEarlier ? (
                          <Button variant="ghost" size="xs" onClick={view.loadEarlier}>
                            {t('bots.items.view.showEarlier', 'Show earlier')}
                          </Button>
                        ) : null}
                        {/* From the list's row, the Activity shows once read: never a false "No comments". */}
                        {view.eventsRead && activityMounted ? (
                          <BotItemActivityList
                            bot={bot}
                            item={item}
                            events={view.events}
                            pending={pending}
                            quickReplies={quickReplies}
                          />
                        ) : null}
                      </section>
                    </div>
                  </div>
                  {/* A soft edge over the comment box: activity scrolling under it reads as more below. */}
                  <div
                    aria-hidden
                    className="pointer-events-none absolute inset-x-0 bottom-0 h-4 bg-linear-to-b from-transparent to-sidebar"
                  />
                  <NativeChatJumpToLatest visible={showJump} onJump={jumpToLatest} />
                </div>
              </NativeChatLinkClickContext>
            </NativeChatFileLinkExistenceContext>
            <LinkActionPopover request={links.linkActionRequest} onClose={links.closeLinkActions} />
            {deleted ? (
              nav ? (
                <BotItemNavRow nav={nav} />
              ) : null
            ) : (
              <BotItemCommentBox
                ref={comment}
                bot={bot}
                item={item}
                attachTo={attachTo}
                nav={nav}
                question={waitingOn}
                onSend={sendFromBox}
              />
            )}
          </NativeChatPaneFileDropSurface>
        </NativeChatTextAttachmentScope>
      </NativeChatMarkdownImageOwnerContext>
      <BotItemCancelDialog
        items={canceling ? [item] : null}
        onCancel={(reason) => {
          setCanceling(false)
          setStatus('canceled', reason)
        }}
        onClose={() => setCanceling(false)}
      />
      {snoozing.dialog}
    </div>
  )
}

function CloseNote({ item }: { item: BotItem }): React.JSX.Element | null {
  const t = useTranslate()
  if (!item.closeNote) {
    return null
  }
  return (
    <p className="rounded-md bg-muted px-2.5 py-2 text-xs text-muted-foreground">
      {item.status === 'canceled'
        ? t('bots.items.view.canceledNote', 'Canceled:')
        : t('bots.items.view.doneNote', 'Done:')}{' '}
      <span className="text-foreground">{item.closeNote}</span>
    </p>
  )
}
