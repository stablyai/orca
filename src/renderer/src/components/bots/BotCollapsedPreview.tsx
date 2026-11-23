import { useMemo, useState, useSyncExternalStore } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { toast } from 'sonner'
import { HoverCardContent } from '@/components/ui/hover-card'
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
import { useTranslate, type Translate } from '@/i18n/use-translate'
import { cn } from '@/lib/class-names'
import { extractPinnedVirtualRange } from '@/lib/list-interaction/pinned-virtual-range'
import { structuredAgentSessionOwnerForTab } from '@/runtime/native-chat/session-ownership/structured-agent-session-owner'
import { useAppStore } from '@/store'
import { selectFrontTab } from '@/store/slices/tabs/active-tab-selection'
import { BotAvatar } from './BotAvatar'
import { BotHoverDetails, useBotRowDetails } from './BotHoverDetails'
import { openBotHomePanelFromSidebar } from './BotRow'
import { botErrorMessage } from './bot-presentation'
import { botSidebarEntryKey } from './bot-sidebar-entry-keys'
import { BotPreviewEdge, BotPreviewPip } from './bot-preview-indicators'
import { useBotHomeWorkers } from './use-bot-sidebar-arrangement'
import {
  botPreviewFaceStart,
  PREVIEW_TRACK_HEIGHT,
  useBotPreviewScroll
} from './use-bot-preview-scroll'

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
  'pointer-events-auto absolute top-1 size-5 shrink-0 cursor-pointer rounded-full ring-2 outline-none focus-visible:z-20 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring focus-visible:outline-solid'

export function BotCollapsedPreview({
  facts,
  onOpenBot
}: {
  facts: Facts[]
  onOpenBot: () => void
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
  const [focusedKey, setFocusedKey] = useState<string | null>(null)
  const { ordered, indexByKey, attentionCount } = useMemo(() => {
    const ordered = rankBotsForPreview(facts).map((fact) => ({
      fact,
      key: botSidebarEntryKey(fact.bot),
      signal: botPreviewSignal(fact)
    }))
    const indexByKey = new Map(ordered.map(({ key }, index) => [key, index]))
    const firstWithoutAttention = ordered.findIndex(({ signal }) => signal !== 'attention')
    return {
      ordered,
      indexByKey,
      attentionCount: firstWithoutAttention === -1 ? ordered.length : firstWithoutAttention
    }
  }, [facts])
  const currentIndex = useMemo(() => {
    if (!activeChat) {
      return undefined
    }
    const index = ordered.findIndex(
      ({ fact: { bot } }) =>
        activeChat.workspaceId === folderWorkspaceKey(bot.folderWorkspaceId) &&
        activeChat.hostId === bot.hostId
    )
    return index === -1 ? undefined : index
  }, [activeChat, ordered])
  const {
    previewRef,
    trackRef,
    trackWidth,
    totalWidth,
    badgeWidth,
    overflow,
    before,
    after,
    firstVisible,
    endVisible,
    firstFull,
    endFull,
    syncWindow,
    revealAvatar,
    pageBots
  } = useBotPreviewScroll(
    ordered.length,
    currentIndex === undefined
      ? undefined
      : { key: ordered[currentIndex]!.key, index: currentIndex }
  )
  const renderedIndexes =
    endVisible > firstVisible
      ? extractPinnedVirtualRange(
          {
            startIndex: firstVisible,
            endIndex: endVisible - 1,
            overscan: 1,
            count: ordered.length
          },
          [focusedKey === null ? undefined : indexByKey.get(focusedKey)]
        )
      : []
  if (openCardKey !== null && !indexByKey.has(openCardKey)) {
    setOpenCardKey(null)
  }
  if (focusedKey !== null && !indexByKey.has(focusedKey)) {
    setFocusedKey(null)
  }
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
  const page = (direction: -1 | 1, keyboard: boolean): void => {
    if (pageBots(direction, keyboard) && keyboard) {
      previewRef.current?.parentElement
        ?.querySelector<HTMLButtonElement>('[data-sidebar-section-fold="bots"]')
        ?.focus({ preventScroll: true })
    }
  }
  return (
    <span
      ref={previewRef}
      className="pointer-events-none relative isolate flex min-w-0 flex-1 items-center justify-center gap-1 pr-1 pl-0.5"
      data-bot-preview=""
    >
      {overflow ? (
        <BotPreviewEdge
          direction={-1}
          count={before}
          attention={Math.min(before, attentionCount)}
          signal={ordered[0]?.signal ?? null}
          width={badgeWidth}
          onPage={page}
        />
      ) : null}
      <span
        ref={trackRef}
        className="scrollbar-none relative min-w-0 overflow-x-auto"
        style={{ width: trackWidth, height: PREVIEW_TRACK_HEIGHT }}
        data-bot-preview-track=""
        onScroll={syncWindow}
      >
        <span className="relative block h-full" style={{ width: totalWidth }}>
          {renderedIndexes.map((index) => {
            const { fact, key, signal } = ordered[index]!
            const isCurrent = index === currentIndex
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
                    style={{ left: botPreviewFaceStart(index) }}
                    onFocus={(event) => {
                      setFocusedKey(key)
                      if (event.currentTarget.matches(':focus-visible')) {
                        revealAvatar(index)
                      }
                    }}
                    onBlur={() => setFocusedKey(null)}
                    onClick={() => openChat(fact.bot)}
                  >
                    <BotAvatar bot={fact.bot} className="size-5 rounded-full text-2xs" />
                    {index >= firstVisible && index < endVisible ? (
                      <BotPreviewPip
                        signal={signal}
                        animateWorking={index >= firstFull && index < endFull}
                      />
                    ) : null}
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
      </span>
      {overflow ? (
        <BotPreviewEdge
          direction={1}
          count={after}
          attention={Math.max(0, attentionCount - (ordered.length - after))}
          signal={ordered[ordered.length - after]?.signal ?? null}
          width={badgeWidth}
          onPage={page}
        />
      ) : null}
    </span>
  )
}

function CollapsedBotHoverDetails({ fact, onOpenHome }: { fact: Facts; onOpenHome: () => void }) {
  const details = useBotRowDetails(fact.bot, fact.home)
  return <BotHoverDetails bot={fact.bot} details={details} onOpenHome={onOpenHome} />
}
