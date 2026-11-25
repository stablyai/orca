// The rows of a bot's Needs you group: Orca's asks (approvals, then the rest, in botNow's order), then
// the items the bot set to Needs you. Five rows, then Show N more; approvals never fold. Rows leave as
// soon as their need clears where Orca reads it, and only focus that leaves with a row moves.
import { memo, useContext, useLayoutEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'
import { botTarget, type BotOnHost } from '@/lib/bot-hosts'
import { useTranslate, type Translate } from '@/i18n/use-translate'
import { openBotHomeTab } from '@/lib/bot-catalog'
import { reviewAccessRequest } from '@/lib/bot-access-requests'
import { WorktreeHostContextBadge } from '@/components/sidebar/workspace-card/host/WorktreeHostContextBadge'
import type { Bot } from '../../../../shared/bot-types'
import type { BotItem } from '../../../../shared/bots/bot-items'
import type { BotSessionActivityRow } from '../../../../shared/bots/bot-activity-model'
import { CONNECTOR_SOURCE_NAMES } from '../../../../shared/connectors/external-conversation-link'
import { approvalDetailPreview } from '../../../../shared/agent-session/requests/prompts/agent-session-approval-detail-preview'
import { manageConnectors } from './AddConnectorDialog'
import { openBotAutomation } from './bot-automation-open'
import { botWorkerRowOpener } from './bot-worker-open'
import { botActivityRowTitle } from './bot-activity-row-title'
import { botErrorMessage } from './bot-presentation'
import { botConnectorTitleText } from './bot-connector-titles'
import { openBotSession } from './bot-session-open'
import { useBotHostLabel } from './use-bot-host-label'
import { useBotSessionPrompt } from './use-bot-session-prompt'
import { useStructuredAgentSessionAsyncQuestionSkip } from '../native-chat/prompts/use-structured-agent-session-async-question-skip'
import type { BotNeedView } from './use-bot-now'
import { NEEDS_YOU_CAP, needsYouFold } from '../../../../shared/bots/needs-you-fold'
import { useApprovalReports } from './use-approval-reports'
import { NeedsYouRowCommit, useNeedsYouFocus, useNeedsYouRefocus } from './use-needs-you-focus'
import { NeedRow, NeedRowBot, StoppedForSignInRow, type StoppedForSignIn } from './BotNeedRow'
import { PairedAskNeedRow } from './BotPairedAskNeedRow'
import { connectorNeed } from './bot-connector-need'
import { BotGroupFacePicturesContext, BotItemFaceFolded } from './items/bot-group-face-pictures'
import { botItemGroupName } from '../../../../shared/bots/bot-item-status-name'

type ReportApproval = (key: string, approval: boolean) => void

/** Orca's asks as the group lists them, beside the items. */
export type BotNeedsYouAsks = {
  /** What needs the owner, as `botNow` reads it and the filter keeps. */
  needs: readonly BotNeedView[]
  /** Runs a sign-in stopped: listed after the asks as context, never counted. */
  stoppedForSignIn: readonly StoppedForSignIn[]
  /** The item a worker's Dispatch is linked to, whose title its ask takes. */
  itemOf: (dispatchId: string) => BotItem | null
}

/** A chat waiting on the owner, said as its prompt reads: an approval, a question, else waiting. */
function SessionNeedRow({
  bot,
  needKey,
  title,
  sessionId,
  onOpen,
  onApproval
}: {
  bot: BotOnHost
  needKey: string
  title: string
  sessionId: string
  onOpen: () => void
  onApproval: ReportApproval
}): React.JSX.Element {
  const t = useTranslate()
  const { prompt } = useBotSessionPrompt(bot, sessionId)
  const { awaiting, save } = useStructuredAgentSessionAsyncQuestionSkip(botTarget(bot), sessionId)
  const approval = prompt?.body.kind === 'approval'
  // Before paint, so an approval sorts first without showing in its old place.
  useLayoutEffect(() => {
    if (!approval) {
      return undefined
    }
    onApproval(needKey, true)
    return () => onApproval(needKey, false)
  }, [approval, needKey, onApproval])
  const action = { label: t('bots.needs.open', 'Open'), onOpen }
  if (prompt?.body.kind === 'approval') {
    const { body } = prompt
    return (
      <NeedRow
        kind="approval"
        title={title}
        detail={permission(t, body.title || null)}
        code={body.detail ? approvalDetailPreview(body.detail).split('\n')[0] : null}
        action={action}
      />
    )
  }
  // The question the chat waits on without stopping, as its host publishes it; Skip settles it here.
  const asked = prompt ? null : awaiting
  return (
    <NeedRow
      kind="question"
      title={title}
      detail={
        prompt?.body.kind === 'question'
          ? prompt.body.question
          : asked?.text || t('bots.needs.waiting', 'Waiting for you')
      }
      action={action}
      skip={
        asked && save
          ? {
              label: t('components.native-chat.question.skip', 'Skip'),
              onOpen: () =>
                void save(asked.itemId).catch((error: unknown) =>
                  toast.error(botErrorMessage(error))
                )
            }
          : null
      }
    />
  )
}

/** "Permission · Bash" when the tool is known, else what any approval says. */
function permission(t: Translate, tool: string | null): string {
  return tool
    ? t('bots.needs.permissionTool', 'Permission · {{tool}}', { tool })
    : t('bots.needs.permission', 'Permission needed')
}

/** A worker's terminal or a terminal run asks in its own pane. */
function paneOpener(row: BotSessionActivityRow, bot: BotOnHost): (() => void) | null {
  switch (row.kind) {
    case 'worker':
      return botWorkerRowOpener(row, botTarget(bot))
    case 'run':
      return () => openBotAutomation(bot.hostId, row.automationId, row.runId)
    case 'thread':
      return null
  }
}

function SessionRowNeed({
  bot,
  needKey,
  row,
  itemOf,
  onApproval
}: {
  bot: Bot
  needKey: string
  row: BotSessionActivityRow
  itemOf: BotNeedsYouAsks['itemOf']
  onApproval: ReportApproval
}): React.JSX.Element {
  const t = useTranslate()
  const title = botActivityRowTitle(row)
  const sessionId = row.kind === 'worker' ? null : row.sessionId
  const hostLabel = useBotHostLabel(row.kind === 'worker' ? (row.hostId ?? 'local') : 'local')
  if (sessionId) {
    return (
      <SessionNeedRow
        bot={bot}
        needKey={needKey}
        title={title}
        sessionId={sessionId}
        onOpen={() => openBotSession(bot, sessionId)}
        onApproval={onApproval}
      />
    )
  }
  const open = paneOpener(row, bot)
  // An item's worker asks under the item's title, its own name first so two of them read apart.
  const item = row.kind === 'worker' && row.dispatchId ? itemOf(row.dispatchId) : null
  const tool = row.kind === 'worker' ? (row.tool ?? null) : null
  const asks =
    row.dot === 'permission'
      ? permission(t, tool?.name ?? null)
      : t('bots.needs.waiting', 'Waiting for you')
  return (
    <NeedRow
      kind={row.dot === 'permission' ? 'approval' : 'question'}
      title={item?.title ?? title}
      worker={item ? title : null}
      number={item?.number ?? null}
      host={hostLabel ? <WorktreeHostContextBadge label={hostLabel} /> : null}
      detail={
        open
          ? asks
          : t('bots.needs.whereItRuns', '{{need}} · open it where it runs', { need: asks })
      }
      code={tool?.input ?? null}
      action={open ? { label: t('bots.needs.open', 'Open'), onOpen: open } : null}
    />
  )
}

const NeedItem = memo(function NeedItem({
  bot,
  need,
  itemOf,
  onApproval
}: {
  bot: Bot
  need: BotNeedView
  itemOf: BotNeedsYouAsks['itemOf']
  onApproval: ReportApproval
}): React.JSX.Element {
  const t = useTranslate()
  switch (need.kind) {
    case 'chat': {
      const title = t('bots.needs.chat', 'Your chat with {{name}}', { name: bot.name })
      const onOpen = (): void => void openBotHomeTab(bot)
      return bot.chatSessionId ? (
        <SessionNeedRow
          bot={bot}
          needKey={need.key}
          title={title}
          sessionId={bot.chatSessionId}
          onOpen={onOpen}
          onApproval={onApproval}
        />
      ) : (
        <NeedRow
          kind="question"
          title={title}
          detail={t('bots.needs.waiting', 'Waiting for you')}
          action={{ label: t('bots.needs.open', 'Open'), onOpen }}
        />
      )
    }
    case 'side-chat':
      return (
        <SessionNeedRow
          bot={bot}
          needKey={need.key}
          title={need.title || t('bots.chats.untitled', 'New chat')}
          sessionId={need.sessionId}
          onOpen={() => openBotSession(bot, need.sessionId)}
          onApproval={onApproval}
        />
      )
    case 'session':
      return (
        <SessionRowNeed
          bot={bot}
          needKey={need.key}
          row={need.row}
          itemOf={itemOf}
          onApproval={onApproval}
        />
      )
    case 'connector': {
      const name = botConnectorTitleText(need.connector.title)
      return (
        <NeedRow
          kind="sign-in"
          title={name}
          detail={connectorNeed(need.connector, name, t)}
          action={{
            label: t('bots.needs.fixConnector', 'Open {{name}}', { name }),
            onOpen: () => manageConnectors(bot, need.connector.key),
            named: true
          }}
        />
      )
    }
    case 'access': {
      const { request } = need
      return (
        <NeedRow
          kind="access"
          title={t('bots.needs.access', '{{person}} asked for access', {
            person: request.requester.name || request.requester.handle
          })}
          detail={`${CONNECTOR_SOURCE_NAMES[request.source]} · ${request.workspaceName}`}
          action={{
            label: t('bots.accessRequest.review', 'Review'),
            onOpen: () => reviewAccessRequest(request)
          }}
        />
      )
    }
    case 'paired-ask':
      return <PairedAskNeedRow bot={bot} card={need.card} />
  }
})

/** A group member's ask: its rows show the member's face. */
function MemberNeedItem(props: React.ComponentProps<typeof NeedItem>): React.JSX.Element {
  return (
    <NeedRowBot.Provider value={props.bot}>
      <NeedItem {...props} />
    </NeedRowBot.Provider>
  )
}

type GroupRow =
  | { key: string; approval: boolean; need: BotNeedView }
  | { key: string; approval: false; stopped: StoppedForSignIn }
  | { key: string; approval: false; item: BotItem }

/** A worker's own dot says it waits on a permission; a chat's prompt says so once read; a paired
 *  server's card always asks for one. */
function knownApproval(need: BotNeedView): boolean {
  return (
    need.kind === 'paired-ask' ||
    (need.kind === 'session' && need.row.kind === 'worker' && need.row.dot === 'permission')
  )
}

const itemKey = (item: BotItem): string => `item:${item.uid}`
const NO_ITEMS: readonly BotItem[] = []

export function BotNeedsYouSection({
  bot,
  asks,
  items = NO_ITEMS,
  renderItem,
  revealUid = null,
  offline = false,
  focusFallback,
  backRow = null
}: {
  /** The asks' bot, or in a group's merged list each ask's own, whose face its row then shows. */
  bot: Bot | ((need: BotNeedView) => Bot)
  asks: BotNeedsYouAsks
  /** The items in Needs you, after the asks, in their group's order. */
  items?: readonly BotItem[]
  renderItem?: (item: BotItem) => React.ReactNode
  /** The item Back returns to: shown even past the cap. */
  revealUid?: string | null
  /** The host is offline: the panel's controls are off, the footer too, so every row shows. */
  offline?: boolean
  /** Takes focus when the focused row leaves and no other row has a control. */
  focusFallback?: React.RefObject<HTMLElement | null>
  /** Back's item row, focused as it mounts. */
  backRow?: { uid: string; ref: (node: HTMLElement | null) => void } | null
}): React.JSX.Element | null {
  const t = useTranslate()
  const { needs, stoppedForSignIn, itemOf } = asks
  const [expanded, setExpanded] = useState(() => {
    const at = revealUid ? items.findIndex((item) => item.uid === revealUid) : -1
    return at >= 0 && needs.length + stoppedForSignIn.length + at >= NEEDS_YOU_CAP
  })
  const { approvals, report: onApproval } = useApprovalReports()
  const rows = useMemo<GroupRow[]>(
    () => [
      ...needs.map((need) => ({
        key: need.key,
        approval: approvals.has(need.key) || knownApproval(need),
        need
      })),
      ...stoppedForSignIn.map((row) => ({
        key: `stopped:${row.key}`,
        approval: false as const,
        stopped: row
      })),
      ...items.map((item) => ({ key: itemKey(item), approval: false as const, item }))
    ],
    [needs, stoppedForSignIn, items, approvals]
  )
  const focus = useNeedsYouFocus()
  const { cardRef, onFocus, onBlur } = focus
  // Only a group panel's row faces read whether their row is folded.
  const faces = useContext(BotGroupFacePicturesContext) !== null
  const fold = needsYouFold(rows, { expanded, focusedKey: focus.focusedKey, showAll: offline })
  const rowCommitted = useNeedsYouRefocus(
    focus,
    fold.ordered.map((row) => row.key),
    focusFallback
  )
  if (!fold.folds && expanded && !offline) {
    // Too few rows to fold: when they grow back, the group starts folded again. Offline shows
    // every row for now, so an opened group stays open for when the host is back.
    setExpanded(false)
  }
  if (rows.length === 0) {
    return null
  }
  const shown = new Set(fold.visible)
  return (
    <div ref={cardRef} className="contents" onFocus={onFocus} onBlur={onBlur}>
      <NeedsYouRowCommit value={rowCommitted}>
        <div role="list" aria-label={botItemGroupName('needs_you', t)} className="contents">
          {fold.ordered.map((row) => {
            const folded = !shown.has(row.key)
            const body =
              'need' in row ? (
                typeof bot === 'function' ? (
                  <MemberNeedItem
                    bot={bot(row.need)}
                    need={row.need}
                    itemOf={itemOf}
                    onApproval={onApproval}
                  />
                ) : (
                  <NeedItem bot={bot} need={row.need} itemOf={itemOf} onApproval={onApproval} />
                )
              ) : 'stopped' in row ? (
                <StoppedForSignInRow row={row.stopped} />
              ) : (
                renderItem?.(row.item)
              )
            return (
              <div
                key={row.key}
                data-need-key={row.key}
                ref={'item' in row && row.item.uid === backRow?.uid ? backRow.ref : undefined}
                // Folded rows stay mounted, so a chat that turns into an approval still sorts first.
                hidden={folded}
              >
                {faces ? (
                  <BotItemFaceFolded.Provider value={folded}>{body}</BotItemFaceFolded.Provider>
                ) : (
                  body
                )}
              </div>
            )
          })}
        </div>
      </NeedsYouRowCommit>
      {fold.hidden > 0 ? (
        <button
          type="button"
          aria-expanded={false}
          onClick={() => setExpanded(true)}
          className="self-start py-0.5 pl-8 pr-2 text-xs text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        >
          {t('bots.items.group.showMore', 'Show {{count}} more', { count: fold.hidden })}
        </button>
      ) : null}
    </div>
  )
}
