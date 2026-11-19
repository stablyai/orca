import React, { useCallback, useMemo, useSyncExternalStore } from 'react'
import { botRefKey, type BotRef } from '@/lib/bot-hosts'
import { toast } from 'sonner'
import StatusIndicator from '@/components/sidebar/workspace-card/surface/StatusIndicator'
import { useWorktreeActivityStatus } from '@/components/sidebar/workspace-card/activity/use-worktree-activity-status'
import {
  BOT_PALETTE_SOURCE_ID,
  type PaletteExtraResult,
  type PaletteExtraSource
} from '@/components/cmd-j/palette-extra-results'
import type { MatchRange } from '../../../../shared/palette-match/normalized-text'
import { getHostKeyedBotSidebarEntries, botSidebarEntryKey } from './bot-sidebar-entry-keys'
import { currentBotPaletteGeneration, revealBotSidebarRowAfterOpen } from './reveal-bot-sidebar-row'
import { matchPaletteDocument } from '../../../../shared/palette-match/match-document'
import {
  buildPaletteDocument,
  type PaletteDocument
} from '../../../../shared/palette-match/palette-document'
import { preparePaletteQuery } from '../../../../shared/palette-match/palette-query'
import { useNow } from '@/lib/window-activity/use-now'
import { useTranslate } from '@/i18n/use-translate'
import { openBotHomeTab, useBotHomeWorkspaces, useBots, useBotsEnabled } from '@/lib/bot-catalog'
import { readBotWaits, subscribeToBotChanges } from '@/lib/bot-catalog-snapshot'
import { openBotGroup } from '@/lib/bot-group-catalog'
import { useBotGroups } from '@/lib/bot-group-list'
import { useBotUpNextUnseen } from '@/lib/bot-up-next-unseen'
import { useAppStore } from '@/store'
import type { Bot } from '../../../../shared/bot-types'
import type { Worktree } from '../../../../shared/worktree/types'
import type { ExecutionHostId } from '../../../../shared/execution-host/execution-host'
import type { BotGroup } from '../../../../shared/bots/bot-group'
import { botGroupStatus } from '../../../../shared/bots/bot-group-status'
import { foldBotStatus } from '../../../../shared/bots/bot-row-status'
import { botGroupMemberBots, botGroupRowLine } from '../../../../shared/bots/bot-sidebar-entries'
import {
  arrangeBotSidebarEntries,
  botSidebarEntryRecency,
  DEFAULT_BOT_SIDEBAR_VIEW
} from '../../../../shared/bots/bot-sidebar-view'
import type { FolderWorkspace } from '../../../../shared/folder-workspaces/folder-workspace-types'
import { getFolderWorkspaceHostIdentity } from '../../../../shared/folder-workspaces/folder-workspace-worktree'
import { getWorktreeHostIdentity } from '../../../../shared/worktree/host-qualified-identity'
import { folderWorkspaceKey } from '../../../../shared/workspace/identity/workspace-scope'
import { BotAvatar } from './BotAvatar'
import { BotGroupTabIcon } from './BotGroupTabIcon'
import { BotRowLineText } from './BotRowActivityLine'
import { BotPaletteLine, readOfflineHostKey } from './bot-palette-line'
import {
  activeTabOf,
  readListedBot,
  readListedGroup,
  requestOpenedChatFocus,
  roomTabOf
} from './bot-palette-open-focus'
import { useBotHostLabel } from './use-bot-host-label'
import { PaletteHostBadgeChip } from '@/components/worktree-jump/rows/worktree-jump-palette-row-content'
import { cn } from '@/lib/class-names'
import { UpNextIcon } from './BotUpNextCount'
import { botErrorMessage } from './bot-presentation'
import { structuredAgentSessionTabId } from '../../../../shared/agent-session/view/structured-agent-session-projection'
import { useBotPurposes } from './use-bot-purposes'

const BOT_PALETTE_EMPTY_QUERY_CAP = 3
const PALETTE_BOT_VIEW = { ...DEFAULT_BOT_SIDEBAR_VIEW, sortBy: 'smart' } as const

/** Bots and groups in Cmd+J, drawn as their sidebar rows; Enter opens a bot's Home chat or a group's room. */
export function useBotPaletteSource({
  query,
  visible
}: {
  query: string
  visible: boolean
}): PaletteExtraSource | null {
  const shown = useBotsEnabled()
  const bots = useBots()
  const groups = useBotGroups()
  const folderWorkspaces = useBotHomeWorkspaces(bots, groups)
  const purposes = useBotPurposes(shown && visible)
  // Which bot servers are unreachable, as one string so the catalog rebuilds only when that changes.
  const offlineHosts = useSyncExternalStore(
    subscribeToBotChanges,
    readOfflineHostKey,
    readOfflineHostKey
  )
  const entries = useMemo(
    () => getHostKeyedBotSidebarEntries(bots, groups, folderWorkspaces),
    [bots, groups, folderWorkspaces]
  )
  const homeIdentities = useMemo(
    () => new Set(entries.map((entry) => getFolderWorkspaceHostIdentity(entry.home))),
    [entries]
  )
  // A home is listed as its owner, never as a workspace; its chats stay in Open Tabs and recents.
  // Stable across queries, so open tabs aren't recomputed by a keystroke that only changes bot results.
  const hidesWorkspace = useCallback(
    (worktree: Worktree) => homeIdentities.has(getWorktreeHostIdentity(worktree)),
    [homeIdentities]
  )
  // Query-independent: order, match documents, and lazily built rows, rebuilt only when the catalog changes.
  const catalog = useMemo(() => {
    if (!shown) {
      return []
    }
    const activityOf = (entry: (typeof entries)[number]) => ({
      needsYou: entry.kind === 'bot' && readBotWaits(entry.bot).length > 0,
      activityAt:
        entry.kind === 'bot'
          ? entry.home.lastActivityAt
          : (entry.group.latest?.at ?? entry.home.lastActivityAt)
    })
    // Waiting on you first, then newest activity, as the section reads with no query.
    return arrangeBotSidebarEntries(entries, PALETTE_BOT_VIEW, activityOf).map((entry) => {
      const purpose = entry.kind === 'bot' ? (purposes.get(botRefKey(entry.bot)) ?? '') : ''
      const name = entry.kind === 'bot' ? entry.bot.name : entry.group.name
      const id = `${entry.kind}:${entry.id}`
      let row: BotPaletteRow | null = null
      const offline = offlineHosts
        .split('\n')
        .includes(entry.kind === 'bot' ? entry.bot.hostId : entry.group.hostId)
      return {
        purpose,
        at: botSidebarEntryRecency(entry, activityOf(entry).activityAt),
        document: botPaletteDocument(id, name, purpose),
        row: (): BotPaletteRow => {
          if (row === null) {
            row =
              entry.kind === 'bot'
                ? botRow(id, entry.bot, entry.home, purpose, offline)
                : groupRow(id, entry.group, entry.home, botGroupMemberBots(entry.group, bots))
          }
          return row
        }
      }
    })
  }, [bots, entries, offlineHosts, purposes, shown])
  const results = useMemo(() => {
    const prepared = preparePaletteQuery(query)
    if (prepared.state === 'empty') {
      return catalog.map((item, order): PaletteExtraResult => ({
        ...item.row(),
        order,
        lastActiveAt: item.at,
        titleRanges: [],
        rank: null,
        qualityClass: null
      }))
    }
    if (prepared.state !== 'ready') {
      return []
    }
    return catalog.flatMap((item, order): PaletteExtraResult[] => {
      const match = matchPaletteDocument({
        document: item.document,
        tokens: prepared.tokens,
        normalizedQuery: prepared.normalized,
        tokenCountBeforeDeduplication: prepared.tokenCountBeforeDeduplication
      })
      if (!match) {
        return []
      }
      const purposeRanges = match.rangesByField.get(PURPOSE_FIELD_ID) ?? []
      const row = item.row()
      return [
        {
          ...row,
          // Only rows whose purpose matched get a new line; the rest reuse the catalog's element.
          ...(purposeRanges.length > 0 && row.purposeLine
            ? { line: row.purposeLine(purposeRanges) }
            : {}),
          order,
          lastActiveAt: item.at,
          titleRanges: match.rangesByField.get(NAME_FIELD_ID) ?? [],
          rank: match.rank,
          qualityClass: match.qualityClass
        }
      ]
    })
  }, [catalog, query])
  return useMemo(
    () => ({
      id: BOT_PALETTE_SOURCE_ID,
      catalogSize: catalog.length,
      sectionLabel: (t) => t('bots.palette.section', 'Bots'),
      emptyQueryCap: BOT_PALETTE_EMPTY_QUERY_CAP,
      emptyQueryPlacement: 'first',
      // Bot names are few and deliberate, so they win ties and sit above Workspaces.
      typedPlacement: 'before-workspaces',
      leadsOnTie: true,
      results,
      hidesWorkspace
    }),
    [catalog.length, hidesWorkspace, results]
  )
}

const NAME_FIELD_ID = 'name'
const PURPOSE_FIELD_ID = 'purpose'

/** Name first, purpose as supporting text, profiled as the seam's fields are. */
function botPaletteDocument(id: string, name: string, purpose: string): PaletteDocument {
  return buildPaletteDocument({
    id,
    visibleFields: [
      {
        id: NAME_FIELD_ID,
        profile: 'structured-label',
        text: name,
        role: 'primary',
        destinationEligible: true
      },
      {
        id: PURPOSE_FIELD_ID,
        profile: 'prose',
        text: purpose,
        role: 'secondary',
        destinationEligible: false
      }
    ],
    evidence: []
  })
}

type BotPaletteRow = Omit<
  PaletteExtraResult,
  'order' | 'lastActiveAt' | 'titleRanges' | 'rank' | 'qualityClass'
> & {
  /** The row's line showing which part of its purpose matched; bots only. */
  purposeLine?: (ranges: readonly MatchRange[]) => React.ReactNode
}

function botRow(
  id: string,
  bot: Bot,
  home: FolderWorkspace,
  purpose: string,
  offline: boolean
): BotPaletteRow {
  return {
    id,
    title: bot.name,
    // An unreachable server outranks paused: its picture and name dim, its line says it's disconnected.
    dimmed: bot.paused && !offline,
    // An unreachable server's bot fails to open: its picture and name dim, its line says it's disconnected.
    subdued: offline,
    leading: <BotPaletteAvatar bot={bot} home={home} />,
    line: <BotPaletteLine bot={bot} home={home} purpose={purpose} purposeRanges={null} />,
    purposeLine: (ranges) => (
      <BotPaletteLine bot={bot} home={home} purpose={purpose} purposeRanges={ranges} />
    ),
    trailing: (
      <>
        <BotPaletteHostChip hostId={bot.hostId} />
        <BotPaletteUpNext bot={bot} />
      </>
    ),
    onSelect: () => {
      const generation = currentBotPaletteGeneration()
      openBotHomeTab(bot)
        .then((opened) => {
          if (!opened) {
            toast.error(botErrorMessage(undefined))
            return
          }
          // A palette opened or anything selected since: leave focus and the sidebar to that.
          if (generation !== currentBotPaletteGeneration()) {
            return
          }
          const tabId = bot.chatSessionId
            ? structuredAgentSessionTabId(bot.chatSessionId)
            : activeTabOf(folderWorkspaceKey(home.id))
          if (!tabId) {
            return
          }
          // Ask for the opened chat's composer outright, so the reveal waits on a focus that is coming.
          requestOpenedChatFocus(tabId)
          revealBotSidebarRowAfterOpen({
            sidebarKey: botSidebarEntryKey(bot),
            readEntry: () => readListedBot(bot),
            generation,
            destinationTabId: tabId
          })
        })
        .catch((error: unknown) => toast.error(botErrorMessage(error)))
    }
  }
}

function groupRow(
  id: string,
  group: BotGroup,
  home: FolderWorkspace,
  members: readonly Bot[]
): BotPaletteRow {
  return {
    id,
    title: group.name,
    leading: <BotGroupPaletteAvatar group={group} members={members} />,
    line: <BotGroupPaletteLine group={group} home={home} members={members} />,
    trailing: <BotPaletteHostChip hostId={group.hostId} />,
    onSelect: () => {
      const generation = currentBotPaletteGeneration()
      // The room's open resolves with nothing: fulfilled means opened, a rejection means it didn't.
      openBotGroup(group).then(
        () => {
          const tabId = roomTabOf(group)
          if (generation !== currentBotPaletteGeneration() || !tabId) {
            return
          }
          requestOpenedChatFocus(tabId)
          revealBotSidebarRowAfterOpen({
            sidebarKey: botSidebarEntryKey(group),
            readEntry: () => readListedGroup(group),
            generation,
            destinationTabId: tabId
          })
        },
        (error: unknown) => toast.error(botErrorMessage(error))
      )
    }
  }
}

/** The sidebar's picture with its status on the corner; idle shows no mark. */
function BotPaletteAvatar({ bot, home }: { bot: Bot; home: FolderWorkspace }): React.JSX.Element {
  const status = foldBotStatus(useWorktreeActivityStatus(folderWorkspaceKey(home.id)), bot.paused)
  return (
    <AvatarWithStatus status={status === 'working' || status === 'permission' ? status : null}>
      <BotAvatar bot={bot} className="size-4 rounded text-[9px]" />
    </AvatarWithStatus>
  )
}

function BotGroupPaletteAvatar({
  group,
  members
}: {
  group: BotGroup
  members: readonly Bot[]
}): React.JSX.Element {
  // Rerun on every store change, as the sidebar row does, so freshness re-reads the clock.
  const status = useAppStore((state) =>
    botGroupStatus(group, state.agentStatusByPaneKey, Date.now())
  )
  return (
    <AvatarWithStatus status={status === 'working' || status === 'permission' ? status : null}>
      <BotGroupTabIcon members={members} />
    </AvatarWithStatus>
  )
}

function AvatarWithStatus({
  status,
  children
}: {
  status: 'working' | 'permission' | null
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <span className="relative flex">
      {children}
      {status ? (
        <span className="absolute -right-1 -bottom-1 flex rounded-full bg-popover p-px">
          <StatusIndicator status={status} showTooltip={false} />
        </span>
      ) : null}
    </span>
  )
}

/** The sidebar row's line, inline; a bot with no activity yet shows what it is for. */
/** A server's bot or group names its server on the right, as a remote workspace row does. */
function BotPaletteHostChip({ hostId }: { hostId: ExecutionHostId }): React.JSX.Element | null {
  const label = useBotHostLabel(hostId)
  return <PaletteHostBadgeChip badge={label ? { hostId, label } : null} />
}

function BotGroupPaletteLine({
  group,
  home,
  members
}: {
  group: BotGroup
  home: FolderWorkspace
  members: readonly Bot[]
}): React.JSX.Element {
  const t = useTranslate()
  const now = useNow(60_000)
  const line = botGroupRowLine(group, members, t('bots.groups.you', 'You'))
  return (
    <span className={cn(home.isUnread && 'text-foreground')}>
      <BotRowLineText line={{ kind: 'activity', place: null, ...line }} now={now} />
    </span>
  )
}

function BotPaletteUpNext({ bot }: { bot: BotRef }): React.JSX.Element | null {
  const t = useTranslate()
  const count = useBotUpNextUnseen(bot)
  if (count === 0) {
    return null
  }
  return (
    <span
      className="flex items-center gap-0.5 text-xs text-muted-foreground tabular-nums"
      aria-label={t('bots.palette.upNext', '{{count}} new suggestions', {
        count,
        defaultValue_one: '{{count}} new suggestion'
      })}
    >
      <UpNextIcon className="size-3" aria-hidden="true" />
      {count}
    </span>
  )
}
