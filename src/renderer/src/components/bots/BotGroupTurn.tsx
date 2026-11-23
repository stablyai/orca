import { useUiLanguageRevision } from '@/i18n/use-ui-language-revision'
import type { ExecutionHostId } from '../../../../shared/execution-host/execution-host'
import { useTranslate } from '@/i18n/use-translate'
import { memo, useCallback, useMemo, useRef, useState } from 'react'
import { createNativeChatMessageListProjection } from '../native-chat/conversation/projection/native-chat-message-list-projection'
import { Reply, Square } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { NativeChatWorkingStatus } from '../native-chat/conversation/turns/NativeChatWorkingStatus'
import type { NativeChatTranscriptRowContext } from '../native-chat/messages/rows/NativeChatTranscriptRow'
import { NativeChatTranscriptRowStack } from '../native-chat/viewport/virtualization/NativeChatTranscriptItems'
import { desktopStructuredTranscript } from '../native-chat/conversation/projection/structured-agent-session-message-projection'
import { buildNativeChatTranscriptSlots } from '../native-chat/conversation/slots/native-chat-transcript-slots'
import { useNativeChatSubagentScope } from '../native-chat/subagents/use-native-chat-subagent-scope'
import {
  closeNativeChatSubagentOnEscape,
  noteNativeChatSubagentParent,
  openNativeChatSubagent,
  useNativeChatOpenSubagent,
  type NativeChatSubagentView
} from '../native-chat/subagents/native-chat-open-subagent'
import { useBotAvatarLook } from './bot-avatar-image'
import { botFallback } from '../../../../shared/bots/bot-avatar-fallback'
import {
  botGroupTurnShowsNothing,
  type BotGroupTurn as Turn,
  withBotGroupTurnAnswer
} from '../../../../shared/bots/bot-group'
import type { BotGroupSession } from './BotGroupSessionReader'
import type { NativeChatTurnStatus } from '../../../../shared/native-chat/transcript/turns/native-chat-turn-status'

import { BotGroupTranscriptOwner, type useBotGroupFileContexts } from './BotGroupTranscriptOwner'
import { useNativeChatFileLinkClick } from '../native-chat/links/actions/use-native-chat-file-link-click'
import { useRecheckNativeChatFileLinksWhenSettled } from '../native-chat/links/actions/use-native-chat-file-link-existence'
import { NativeChatLinkClickContext } from '../native-chat/links/actions/native-chat-link-click-context'
import type { CommentMarkdownLinkClickHandler } from '@/components/comment-markdown/comment-markdown-element-renderers'
import { routeNativeChatHref } from '../../../../shared/native-chat/file-access/native-chat-href-routing'
import type { BotGroupRoomLinks } from './use-bot-group-room-links'
import { type BotGroupTranscriptRows, useBotGroupTranscriptRows } from './bot-group-transcript-rows'
import { botCodedText } from '../../../../shared/bots/bot-failure-copy'
import { callBotRpc } from '@/lib/bot-hosts'
import type { AgentJournalRenderItem } from '../../../../shared/agent-session/journal/agent-session-journal-types'
const noItems: never[] = []
export const BotGroupTurn = memo(function BotGroupTurn({
  hostId,
  groupId,
  turn,
  session,
  onStop,
  onReply,
  scrollMessageToTop,
  files,
  roomLinks,
  roomRows,
  tabId,
  isVisible
}: {
  /** The group's host, which runs its members. */
  hostId: ExecutionHostId
  groupId: string
  turn: Turn
  files: ReturnType<typeof useBotGroupFileContexts> extends Map<string, infer Context>
    ? Context | null
    : never
  roomLinks: BotGroupRoomLinks
  roomRows: BotGroupTranscriptRows
  tabId: string
  isVisible: boolean
  session?: BotGroupSession
  onStop: (botId: string) => void
  onReply: (botId: string) => void
  scrollMessageToTop: (element: HTMLElement) => void
}): React.JSX.Element {
  const t = useTranslate()
  useUiLanguageRevision()
  const [expanded, setExpanded] = useState(false)
  const bot = useMemo(
    () => ({
      hostId,
      id: turn.botId,
      name: turn.botName,
      avatar: turn.avatar,
      avatarColor: turn.avatarColor,
      avatarOutfit: turn.avatarOutfit
    }),
    [hostId, turn.botId, turn.botName, turn.avatar, turn.avatarColor, turn.avatarOutfit]
  )
  const { src, outfit } = useBotAvatarLook(bot)
  const submissions = session?.submissions ?? noItems
  const readTurn = session?.groupTurnItems
  // Its own rows, read once when its reader opens an ended turn its chat's loaded page does not hold.
  const [openedItems, setOpenedItems] = useState<AgentJournalRenderItem[] | null>(null)
  const opening = useRef(false)
  const items = useMemo(() => {
    const loaded = turn.frozenItems ?? readTurn?.(turn.operationId, turn.workerDispatchIds)
    const hasTurnRow = loaded?.some((item) => item.body.kind === 'turn')
    return (hasTurnRow ? loaded : (openedItems ?? loaded)) ?? noItems
  }, [turn.frozenItems, turn.operationId, turn.workerDispatchIds, readTurn, openedItems])
  // Saved with its reply when it ended; older saves carry only the reply.
  const ended = turn.end !== undefined || turn.reply !== undefined
  const canonical = items.find((item) => item.body.kind === 'turn')
  const lifecycle = canonical?.body.kind === 'turn' ? canonical.body : null
  const submission = submissions.find(
    (item) => item.clientMessageId === turn.operationId || item.queuedMessageId === turn.operationId
  )
  const queued = session?.queuedMessages.cards.some((card) => card.messageId === turn.operationId)
  // Running only while its session works and nothing saved its end: a stale loaded row never is.
  const working =
    !turn.revoked && !ended && lifecycle?.state === 'running' && session?.isWorking !== false
  const rejection =
    (turn.error === undefined ? null : botCodedText(turn.error, turn.failure, t)) ??
    (submission?.dispatchState === 'rejected' ? submission.reason : null)
  const status = useMemo<NativeChatTurnStatus>(
    () =>
      !lifecycle && ended
        ? {
            thinking: false,
            startedAt: null,
            workedSeconds: (turn.workedMs ?? 0) / 1000,
            verdict:
              turn.end === 'stopped'
                ? 'cancellation'
                : turn.end === 'failed'
                  ? 'failure'
                  : 'success'
          }
        : {
            thinking: false,
            startedAt: lifecycle?.startedAt ?? null,
            workedSeconds:
              lifecycle && lifecycle.state !== 'running'
                ? (lifecycle.durationMs ??
                    (lifecycle.completedAt !== undefined && lifecycle.startedAt !== undefined
                      ? lifecycle.completedAt - lifecycle.startedAt
                      : 0)) / 1000
                : null,
            verdict: lifecycle?.outcome
          },
    [lifecycle, ended, turn.workedMs, turn.end]
  )
  const projection = useMemo(() => desktopStructuredTranscript.transcript(items), [items])
  const project = useMemo(() => createNativeChatMessageListProjection(), [])
  const projected = useMemo(
    () => project(projection.messages, { items, submissions }),
    [project, projection.messages, items, submissions]
  )
  const messages = useMemo(
    () =>
      withBotGroupTurnAnswer(
        projected.conversation.filter((message) => message.role !== 'user'),
        {
          operationId: turn.operationId,
          answer: turn.answer,
          reply: ended ? turn.reply : undefined
        }
      ),
    [projected.conversation, turn.operationId, turn.answer, ended, turn.reply]
  )
  const noReply = ended && botGroupTurnShowsNothing(messages)
  useBotGroupTranscriptRows(roomRows, turn.operationId, messages)
  // Each room turn opens its subagents in place, as a chat pane does, keyed to this turn.
  const subagentKey = `bot-group-turn:${turn.operationId}`
  const openId = useNativeChatOpenSubagent(subagentKey)?.agentId ?? null
  const subagentView = useMemo<NativeChatSubagentView>(
    () => ({
      agentId: openId,
      open: (agentId) => openNativeChatSubagent(subagentKey, agentId),
      noteParent: (parentId) =>
        openId === null ? undefined : noteNativeChatSubagentParent(subagentKey, openId, parentId)
    }),
    [openId, subagentKey]
  )
  const scope = useNativeChatSubagentScope({
    view: subagentView,
    conversation: messages,
    subagentRows: projected.subagentRows,
    roster: session?.subagentRoster,
    journalItems: items,
    journalSubmissions: submissions,
    latestTurn: undefined,
    isWorking: working
  })
  const subagentOpen = scope.agentId !== null
  const scopeMessages = scope.messages
  const subagentHeads = scope.heads
  const expandedKeys = useMemo(
    () => (expanded ? new Set([turn.operationId]) : new Set<string>()),
    [expanded, turn.operationId]
  )
  const slots = useMemo(
    () =>
      buildNativeChatTranscriptSlots({
        messages: scopeMessages,
        // A subagent's own rows sit in no turn of the room's.
        turnKeys: scopeMessages.map(() => (subagentOpen ? undefined : turn.operationId)),
        liveTurnKey: working && !subagentOpen ? turn.operationId : undefined,
        receipts: projection.receipts,
        turnStatuses: {
          active: working && !subagentOpen ? status : null,
          completedByTurn: working || subagentOpen ? {} : { [turn.operationId]: status }
        },
        expandedTurnKeys: expandedKeys,
        turnDiffs: new Map(),
        isWorking: scope.working,
        lifecycleWorking: scope.working,
        subagentHeads
      }),
    [
      scopeMessages,
      subagentOpen,
      turn.operationId,
      working,
      projection.receipts,
      status,
      expandedKeys,
      scope.working,
      subagentHeads
    ]
  )
  // The turn's own header line draws its status; its rows must not draw it again.
  const rows = useMemo(
    () => slots.map((slot) => (slot.kind === 'message' ? { ...slot, status: undefined } : slot)),
    [slots]
  )
  useRecheckNativeChatFileLinksWhenSettled(files?.existence ?? null, working)
  const openFileLink = useNativeChatFileLinkClick(
    files?.fileLinkContext ?? null,
    roomLinks.request,
    roomLinks.rootRef
  )
  // A member's file paths resolve in its own folder; web links open from the room's tab.
  const onLinkClick = useCallback<CommentMarkdownLinkClickHandler>(
    (event, href) =>
      (routeNativeChatHref(href).kind === 'file' ? openFileLink : roomLinks.onLinkClick)?.(
        event,
        href
      ),
    [openFileLink, roomLinks.onLinkClick]
  )
  const toggleExpanded = () => {
    setExpanded(!expanded)
    if (lifecycle || opening.current) {
      return
    }
    opening.current = true
    callBotRpc<{ items: AgentJournalRenderItem[] }>({ hostId }, 'bots.groups.turnRows', {
      groupId,
      operationId: turn.operationId
    })
      .then((result) => setOpenedItems(result.items))
      .catch(() => {
        opening.current = false
      })
  }
  const context: NativeChatTranscriptRowContext = {
    runtimeContext: files?.runtimeContext,
    expandSignal: false,
    revealedDiff: null,
    taskListPredecessors: new Map(),
    expandedTurnIds: expandedKeys,
    onToggleExpandedTurn: toggleExpanded,
    onOpenSubagent: scope.open,
    onScrollMessageToTop: scrollMessageToTop,
    readerAtEnd: () => true,
    onRevealDiff: () => {},
    actionablePromptIds: session?.hostWork?.actionablePromptIds
  }
  const waiting = !lifecycle && !rejection && !ended
  const membershipEnded = turn.revoked && lifecycle?.state !== 'completed'
  const pendingLabel = membershipEnded
    ? t('bots.groups.memberRemoved', 'Member removed')
    : waiting
      ? queued
        ? t('components.native-chat.queuedMessages.queued', 'Queued')
        : submission?.dispatchState === 'unknown'
          ? t('bots.groups.deliveryUnconfirmed', 'Delivery unconfirmed')
          : submission?.handoverRecorded && !submission.handedOverAt
            ? t('components.native-chat.queuedMessages.queued', 'Queued')
            : t('bots.groups.starting', 'Starting…')
      : rejection
        ? t('bots.groups.notStarted', 'Not started')
        : !lifecycle && ended && turn.workedMs === undefined
          ? t('components.agentChildRow.ended', 'Ended')
          : undefined
  return (
    <BotGroupTranscriptOwner
      context={files}
      sessionId={turn.sessionId}
      tabId={tabId}
      isVisible={isVisible}
    >
      {/* File links open on the member's host; room links go to the room. */}
      <NativeChatLinkClickContext value={onLinkClick}>
        <section
          data-group-turn={turn.operationId}
          data-group-bot={turn.botId}
          className="space-y-4"
          onKeyDown={(event) => closeNativeChatSubagentOnEscape(event, subagentKey)}
        >
          <NativeChatWorkingStatus
            bot={{ name: turn.botName, src, outfit, fallback: botFallback(bot), showName: true }}
            {...status}
            pendingLabel={pendingLabel}
            workedSeconds={membershipEnded || waiting || rejection ? 0 : status.workedSeconds}
            expanded={expanded}
            onToggleExpanded={lifecycle || ended ? toggleExpanded : undefined}
            actions={
              <>
                {!turn.revoked && !rejection && (working || waiting) ? (
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    aria-label={t('bots.groups.stopValue', 'Stop {{value0}}', {
                      value0: turn.botName
                    })}
                    onClick={() => onStop(turn.botId)}
                  >
                    <Square className="size-3" />
                  </Button>
                ) : null}
                <Button
                  variant="ghost"
                  size="icon-xs"
                  aria-label={t('bots.groups.replyToValue', 'Reply to {{value0}}', {
                    value0: turn.botName
                  })}
                  onClick={() => onReply(turn.botId)}
                >
                  <Reply className="size-3.5" />
                </Button>
              </>
            }
          />
          {rejection ? (
            <p role="alert" className="text-sm text-chat-warning">
              {rejection}
            </p>
          ) : null}
          {scope.bar}
          {scope.lead}
          <NativeChatTranscriptRowStack slots={rows} context={context} />
          {noReply && !rejection ? (
            <p className="text-sm text-chat-foreground-faint">
              {turn.end === 'stopped'
                ? t(
                    'components.native-chat.subagents.stoppedBeforeReply',
                    'Stopped before replying'
                  )
                : t('components.native-chat.subagents.noReply', 'Ended without a reply')}
            </p>
          ) : null}
        </section>
      </NativeChatLinkClickContext>
    </BotGroupTranscriptOwner>
  )
})
