// A bot's thread and run sessions get no tab until someone opens one; while they have none, these stand
// in for their tab wherever native chat follows a tab, so they keep a status dot and still notify.
// A group member's session never gets one: it stands in where its room lives, the group's home.
import { readHostBots, subscribeToBotChanges } from '@/lib/bot-catalog-snapshot'
import { ownBotHost } from '@/lib/bot-hosts'
import { readBotGroups } from '@/lib/bot-group-catalog-snapshot'
import { watchBotGroups } from '@/lib/bot-group-list'
import { getStructuredAgentSessionStatusFeed } from '@/runtime/native-chat/status/structured-agent-session-status-feed'
import { useAppStore } from '@/store'
import type { StructuredAgentSessionStatusChange } from '@/runtime/native-chat/status/structured-agent-session-status-dispatch'
import type { AgentSessionStatusSummary } from '../../../../shared/agent-session/agent-session-wire'
import type { AgentSessionStatusSnapshot } from '../../../../shared/agent-session/view/agent-session-status-snapshot-fold'
import type { Bot } from '../../../../shared/bot-types'
import { isBotGroupMemberSession, type BotGroup } from '../../../../shared/bots/bot-group'
import { isStructuredAgentId } from '../../../../shared/agent-session/lifecycle/provider-handles/agent-session-provider-handle-encoding'
import { structuredAgentSessionTabId } from '../../../../shared/agent-session/view/structured-agent-session-projection'
import type { Tab } from '../../../../shared/workspace-layout/tab-groups/tab-types'
import { folderWorkspaceKey } from '../../../../shared/workspace/identity/workspace-scope'
import {
  getStructuredAgentSessionTabs,
  type StructuredTab
} from '../native-chat/session/status/structured-agent-session-tabs'

const NO_SESSIONS: readonly StructuredTab[] = []

/** This app's own host's bots, whose tabless sessions its own status feed lists. */
function readBots(): readonly Bot[] {
  return readHostBots(ownBotHost().hostId)
}

function ownSessionFeed() {
  return getStructuredAgentSessionStatusFeed(ownBotHost().target)
}

const groupHomesByGroups = new WeakMap<readonly BotGroup[], Map<string, string>>()

/** Each current or former member session's group home; the first group holding it wins, as in findBotGroupRoomOfSession. */
function groupHomesBySession(groups: readonly BotGroup[]): Map<string, string> {
  let homes = groupHomesByGroups.get(groups)
  if (!homes) {
    homes = new Map()
    for (const group of groups) {
      const home = folderWorkspaceKey(group.folderWorkspaceId)
      for (const room of [group, ...(group.threads ?? [])]) {
        for (const sessionId of [
          ...room.members.map((member) => member.sessionId),
          ...(room.formerSessionIds ?? [])
        ]) {
          if (!homes.has(sessionId)) {
            homes.set(sessionId, home)
          }
        }
      }
    }
    groupHomesByGroups.set(groups, homes)
  }
  return homes
}

/** Where a bot session with no tab stands in; null when it has a tab or is no bot's. */
function botSessionStandIn(
  bots: readonly Bot[],
  groups: readonly BotGroup[],
  unifiedTabsByWorktree: Record<string, Tab[]>
): (summary: AgentSessionStatusSummary) => string | null {
  const homes = new Set<string>(bots.map((bot) => folderWorkspaceKey(bot.folderWorkspaceId)))
  const groupHomes = groupHomesBySession(groups)
  const opened = new Map<string, Set<string>>()
  return ({ sessionId, workspaceId, agent }) => {
    if (!homes.has(workspaceId) || !isStructuredAgentId(agent)) {
      return null
    }
    let tabbed = opened.get(workspaceId)
    if (!tabbed) {
      tabbed = new Set((unifiedTabsByWorktree[workspaceId] ?? []).map((tab) => tab.entityId))
      opened.set(workspaceId, tabbed)
    }
    if (tabbed.has(sessionId)) {
      return null
    }
    return isBotGroupMemberSession(sessionId)
      ? (groupHomes.get(sessionId) ?? workspaceId)
      : workspaceId
  }
}

function projectBotSessions(
  sessions: AgentSessionStatusSnapshot,
  standIn: (summary: AgentSessionStatusSummary) => string | null
): readonly StructuredTab[] {
  const tabs: StructuredTab[] = []
  for (const summary of sessions.values()) {
    const worktreeId = standIn(summary)
    if (worktreeId === null) {
      continue
    }
    const { sessionId, agent } = summary
    const id = structuredAgentSessionTabId(sessionId)
    tabs.push({
      id,
      entityId: sessionId,
      groupId: id,
      worktreeId,
      contentType: 'agent-session',
      agentSessionAgent: agent,
      label: '',
      customLabel: null,
      color: null,
      sortOrder: 0,
      createdAt: 0
    })
  }
  return tabs.length > 0 ? tabs : NO_SESSIONS
}

/** The bot sessions this host lists that have no tab, each as the tab it would open as. */
export function botBackgroundSessionTabs(
  bots: readonly Bot[],
  groups: readonly BotGroup[],
  sessions: AgentSessionStatusSnapshot,
  unifiedTabsByWorktree: Record<string, Tab[]>
): readonly StructuredTab[] {
  if (bots.length === 0) {
    return NO_SESSIONS
  }
  return projectBotSessions(sessions, botSessionStandIn(bots, groups, unifiedTabsByWorktree))
}

let current: readonly StructuredTab[] = NO_SESSIONS
let currentBySession = new Map<string, StructuredTab>()
const listeners = new Set<() => void>()
let stopWatching: (() => void) | null = null
type StandIn = {
  bots: readonly Bot[]
  groups: readonly BotGroup[]
  unifiedTabsByWorktree: Record<string, Tab[]>
  place: (summary: AgentSessionStatusSummary) => string | null
}
let standIn: StandIn | null = null

/** The stand-in rule for the bots, groups and tabs as they are now, rebuilt only when one of them changes. */
function readStandIn(): StandIn {
  const bots = readBots()
  const groups = readBotGroups()
  const { unifiedTabsByWorktree } = useAppStore.getState()
  if (
    standIn?.bots !== bots ||
    standIn.groups !== groups ||
    standIn.unifiedTabsByWorktree !== unifiedTabsByWorktree
  ) {
    standIn = {
      bots,
      groups,
      unifiedTabsByWorktree,
      place: botSessionStandIn(bots, groups, unifiedTabsByWorktree)
    }
  }
  return standIn
}

function recompute(): void {
  // Without bots there is nothing to stand in for, so the host's sessions are not read.
  let next = NO_SESSIONS
  if (readBots().length === 0) {
    standIn = null
  } else {
    const sessions = ownSessionFeed().getSnapshot()
    next = projectBotSessions(sessions, readStandIn().place)
  }
  // Keep each session's object, so a status change elsewhere does not resubscribe its readers.
  const kept = next.map((tab) => {
    const prior = currentBySession.get(tab.entityId)
    return prior?.worktreeId === tab.worktreeId && prior.agentSessionAgent === tab.agentSessionAgent
      ? prior
      : tab
  })
  if (kept.length === current.length && kept.every((tab, index) => tab === current[index])) {
    return
  }
  current = kept.length > 0 ? kept : NO_SESSIONS
  currentBySession = new Map(current.map((tab) => [tab.entityId, tab]))
  listeners.forEach((listener) => listener())
}

// The feed keeps each session's place in its order, so an update that leaves every touched session
// standing in where it was (or not at all) leaves the projection as it was.
function onSessionsChange(change: StructuredAgentSessionStatusChange): void {
  const prior = standIn
  const rule = readStandIn()
  if (change !== null && rule === prior) {
    const sessions = ownSessionFeed().getSnapshot()
    const unmoved = (sessionId: string): boolean => {
      const summary = sessions.get(sessionId)
      const worktreeId = summary ? rule.place(summary) : null
      const shown = currentBySession.get(sessionId)
      return worktreeId === null
        ? shown === undefined
        : shown?.worktreeId === worktreeId && shown.agentSessionAgent === summary?.agent
    }
    if (Array.from(change).every(unmoved)) {
      return
    }
  }
  recompute()
}

function watch(): () => void {
  // Only someone with bots listens to this host's sessions; everyone else pays nothing.
  let stopFeed: (() => void) | null = null
  let stopGroups: (() => void) | null = null
  const follow = (): void => {
    if (readBots().length > 0) {
      stopFeed ??= ownSessionFeed().subscribe(onSessionsChange)
      stopGroups ??= watchBotGroups(recompute)
    } else {
      stopFeed?.()
      stopFeed = null
      stopGroups?.()
      stopGroups = null
    }
    recompute()
  }
  const stops = [
    subscribeToBotChanges(follow),
    useAppStore.subscribe((state, previous) => {
      if (state.unifiedTabsByWorktree !== previous.unifiedTabsByWorktree) {
        recompute()
      }
    })
  ]
  follow()
  return () => {
    stops.forEach((stop) => stop())
    stopFeed?.()
    stopGroups?.()
  }
}

/** Watches only while something reads them; Home's own tab keeps this host's status feed open. */
export function subscribeBotBackgroundSessionTabs(listener: () => void): () => void {
  listeners.add(listener)
  stopWatching ??= watch()
  return () => {
    listeners.delete(listener)
    if (listeners.size === 0) {
      stopWatching?.()
      stopWatching = null
      current = NO_SESSIONS
      currentBySession = new Map()
      standIn = null
    }
  }
}

export function readBotBackgroundSessionTabs(): readonly StructuredTab[] {
  return current
}

/** Every structured tab, a bot's tabless sessions first so a session that just got its tab projects for it. */
export function withBotSessions(
  unifiedTabsByWorktree: Record<string, Tab[]>
): readonly StructuredTab[] {
  return joinBotSessions(current, getStructuredAgentSessionTabs(unifiedTabsByWorktree))
}

let lastJoin: {
  background: readonly StructuredTab[]
  tabs: readonly StructuredTab[]
  joined: readonly StructuredTab[]
} | null = null

/** The same list for the same inputs, so the status bridge's identity skip holds while a bot has
 *  tabless sessions. */
export function joinBotSessions(
  background: readonly StructuredTab[],
  tabs: readonly StructuredTab[]
): readonly StructuredTab[] {
  if (background.length === 0) {
    return tabs
  }
  if (lastJoin?.background !== background || lastJoin.tabs !== tabs) {
    lastJoin = { background, tabs, joined: [...background, ...tabs] }
  }
  return lastJoin.joined
}
