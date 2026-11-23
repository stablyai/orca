import { useMemo, useState, useSyncExternalStore } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { toast } from 'sonner'
import { HoverCardContent } from '@/components/ui/hover-card'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { ActivityThreadHoverCardRoot } from '@/components/activity/thread-preview/activity-thread-hover-card-root'
import { openBotHomeTab } from '@/lib/bot-catalog'
import {
  readBotHostState,
  readBotItemsNeedingOwner,
  subscribeToBotChanges
} from '@/lib/bot-catalog-snapshot'
import {
  botPreviewFacts,
  botPreviewSignal,
  rankBotsForPreview
} from '../../../../shared/bots/bot-collapsed-preview'
import type { Bot } from '../../../../shared/bot-types'
import type { FolderWorkspace } from '../../../../shared/folder-workspaces/folder-workspace-types'
import { folderWorkspaceKey } from '../../../../shared/workspace/identity/workspace-scope'
import { AgentQuestionIcon } from '@/components/agent/status/AgentQuestionIcon'
import { AgentWorkingSpinner } from '@/components/agent/status/AgentWorkingSpinner'
import { unreadAlertDotClassName } from '@/components/sidebar/workspace-card/surface/WorktreeCardStatusSlot'
import { useTranslate, type Translate } from '@/i18n/use-translate'
import { cn } from '@/lib/class-names'
import { structuredAgentSessionOwnerForTab } from '@/runtime/native-chat/session-ownership/structured-agent-session-owner'
import { useAppStore } from '@/store'
import { selectFrontTab } from '@/store/slices/tabs/active-tab-selection'
import { BotAvatar } from './BotAvatar'
import { BotHoverDetails, useBotRowDetails } from './BotHoverDetails'
import { openBotHomePanelFromSidebar } from './BotRow'
import { botErrorMessage } from './bot-presentation'
import { botSidebarEntryKey } from './bot-sidebar-entry-keys'
import { useBotHomeWorkers } from './use-bot-sidebar-arrangement'
import { useBotPreviewScroll } from './use-bot-preview-scroll'

export function useBotPreviewFacts(rows: { bot: Bot; home: FolderWorkspace }[]) {
  const homes = useMemo(() => rows.map(({ home }) => home), [rows])
  const homeWorkers = useBotHomeWorkers(homes)
  const readItemsAttention = (): string =>
    rows
      .filter(
        ({ bot }) =>
          !bot.paused &&
          readBotHostState(bot.hostId) === 'live' &&
          (readBotItemsNeedingOwner(bot) ?? 0) > 0
      )
      .map(({ bot }) => botSidebarEntryKey(bot))
      .join('\n')
  const itemAttentionKeys = useSyncExternalStore(
    subscribeToBotChanges,
    readItemsAttention,
    readItemsAttention
  )
  const itemsAttention = useMemo(() => new Set(itemAttentionKeys.split('\n')), [itemAttentionKeys])
  return rows.map(({ bot, home }, index) => {
    const facts = botPreviewFacts({
      own: homeWorkers[index]!.own,
      workspaces: homeWorkers[index]!.workerStatuses,
      homeUnread: home.isUnread,
      paused: bot.paused
    })
    return {
      ...facts,
      bot,
      home,
      attention: facts.attention || itemsAttention.has(botSidebarEntryKey(bot))
    }
  })
}

type Facts = ReturnType<typeof useBotPreviewFacts>[number]
function label(fact: Facts, t: Translate): string {
  const status =
    botPreviewSignal(fact) === 'attention'
      ? t('sidebar.cardSlot.needsYou', 'Needs you')
      : fact.status === 'working' || fact.status === 'monitoring'
        ? t('sidebar.cardSlot.working', 'Working')
        : fact.paused
          ? t('bots.row.paused', 'Paused')
          : t('bots.row.idle', 'Idle')
  return [fact.bot.name, status, ...(fact.unread ? [t('bots.chats.unread', 'Unread')] : [])].join(
    ' · '
  )
}

// Each face is its own target, spread apart and still under the pointer; the header around them still folds.
const FACE_CLASS_NAME =
  'pointer-events-auto relative size-5 shrink-0 cursor-pointer rounded-full ring-2 outline-none focus-visible:z-20 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring focus-visible:outline-solid'

export function BotCollapsedPreview({
  facts,
  onOpenBot,
  onExpand
}: {
  facts: Facts[]
  onOpenBot: () => void
  onExpand: () => void
}) {
  const t = useTranslate()
  const activeChat = useAppStore(
    useShallow((state) => {
      const tab = selectFrontTab(state)
      return tab?.contentType === 'agent-session'
        ? { workspaceId: tab.worktreeId, hostId: structuredAgentSessionOwnerForTab(state, tab) }
        : null
    })
  )
  const [openCardKey, setOpenCardKey] = useState<string | null>(null)
  const current = facts.find(
    ({ bot }) =>
      activeChat?.workspaceId === folderWorkspaceKey(bot.folderWorkspaceId) &&
      activeChat.hostId === bot.hostId
  )
  const { previewRef, trackRef, trackWidth, badgeWidth, visibleCount, firstVisible } =
    useBotPreviewScroll(facts.length, current && botSidebarEntryKey(current.bot))
  const ranked = rankBotsForPreview(facts)
  const hidden =
    ranked.length > visibleCount
      ? [...ranked.slice(0, firstVisible), ...ranked.slice(firstVisible + visibleCount)]
      : []
  if (openCardKey !== null && !ranked.some(({ bot }) => botSidebarEntryKey(bot) === openCardKey)) {
    setOpenCardKey(null)
  }
  const hiddenAttention = hidden.filter((fact) => botPreviewSignal(fact) === 'attention')
  const hiddenSignal = hidden[0] ? botPreviewSignal(hidden[0]) : null
  const overflowLabel = t('bots.section.showMore', 'Show {{count}} more bots', {
    count: hidden.length,
    defaultValue_one: 'Show {{count}} more bot'
  })
  const openChat = (bot: Bot): void => {
    setOpenCardKey(null)
    void openBotHomeTab(bot)
      .then((opened) => {
        if (opened) {
          onOpenBot()
        }
      })
      .catch((error: unknown) => toast.error(botErrorMessage(error)))
  }
  const openHomePanel = (bot: Bot): void => {
    setOpenCardKey(null)
    openBotHomePanelFromSidebar(bot, onOpenBot)
  }
  return (
    <span
      ref={previewRef}
      className="pointer-events-none relative isolate flex min-w-0 flex-1 items-center justify-center gap-1 pr-1 pl-0.5"
      data-bot-preview=""
    >
      <span
        ref={trackRef}
        className="scrollbar-none relative flex min-w-0 items-center gap-1 overflow-x-auto p-1"
        style={trackWidth === undefined ? undefined : { width: trackWidth }}
        data-bot-preview-track=""
      >
        {ranked.map((fact) => {
          const key = botSidebarEntryKey(fact.bot)
          const isCurrent = fact === current
          const cardOpen = key === openCardKey
          return (
            <ActivityThreadHoverCardRoot
              key={key}
              open={cardOpen}
              onOpenChange={(open) =>
                setOpenCardKey(
                  open ? key : (currentKey) => (currentKey === key ? null : currentKey)
                )
              }
              pointerOpenMode={openCardKey === null ? 'rest' : 'immediate'}
              closeDelay={120}
              trigger={
                <button
                  type="button"
                  aria-label={label(fact, t)}
                  aria-current={isCurrent || undefined}
                  className={cn(
                    FACE_CLASS_NAME,
                    isCurrent ? 'ring-sidebar-foreground' : 'ring-sidebar hover:ring-sidebar-ring'
                  )}
                  onClick={() => openChat(fact.bot)}
                >
                  <BotAvatar bot={fact.bot} className="size-5 rounded-full text-2xs" />
                  <PreviewPip signal={botPreviewSignal(fact)} />
                </button>
              }
            >
              {cardOpen ? (
                <HoverCardContent
                  side="top"
                  sideOffset={8}
                  collisionPadding={8}
                  variant="workspace-details"
                  motion="none"
                  className="max-h-(--radix-hover-card-content-available-height)"
                >
                  <CollapsedBotHoverDetails
                    fact={fact}
                    onOpenHome={() => openHomePanel(fact.bot)}
                  />
                </HoverCardContent>
              ) : null}
            </ActivityThreadHoverCardRoot>
          )
        })}
      </span>
      {hidden.length > 0 ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              aria-label={
                hiddenAttention.length === 0
                  ? overflowLabel
                  : `${overflowLabel} · ${t('bots.connectors.needYou', '{{count}} need you', {
                      count: hiddenAttention.length,
                      defaultValue_one: '{{count}} needs you'
                    })}`
              }
              className={cn(
                FACE_CLASS_NAME,
                'flex items-center justify-center bg-muted text-3xs font-medium text-muted-foreground tabular-nums ring-sidebar hover:ring-sidebar-ring'
              )}
              style={{ width: badgeWidth }}
              onClick={onExpand}
            >
              +{hidden.length}
              <PreviewPip signal={hiddenSignal} />
            </button>
          </TooltipTrigger>
          <TooltipContent side="bottom">
            {hidden.map((fact) => label(fact, t)).join(', ')}
          </TooltipContent>
        </Tooltip>
      ) : null}
    </span>
  )
}

function CollapsedBotHoverDetails({ fact, onOpenHome }: { fact: Facts; onOpenHome: () => void }) {
  const details = useBotRowDetails(fact.bot, fact.home)
  return <BotHoverDetails bot={fact.bot} details={details} onOpenHome={onOpenHome} />
}

function PreviewPip({ signal }: { signal: ReturnType<typeof botPreviewSignal> }) {
  if (signal === 'attention') {
    return (
      <span className="pointer-events-none absolute -right-1 -bottom-1 z-10 flex size-3.5 items-center justify-center rounded-full bg-sidebar">
        <AgentQuestionIcon className="size-3" />
      </span>
    )
  }
  if (signal === 'working') {
    return (
      <span className="pointer-events-none absolute -right-1 -bottom-1 z-10 flex size-3 items-center justify-center rounded-full bg-sidebar">
        <AgentWorkingSpinner className="size-2.5" />
      </span>
    )
  }
  return signal === 'unread' ? (
    <span className={cn(unreadAlertDotClassName, 'z-10')} aria-hidden="true" />
  ) : null
}
