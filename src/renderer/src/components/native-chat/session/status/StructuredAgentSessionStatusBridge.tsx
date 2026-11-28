import { createStructuredSessionStatusBurst } from './structured-agent-session-status-burst'
import { useEffect } from 'react'
import { projectStatus } from './structured-agent-session-status-projection'
import { getStructuredAgentSessionLaunchLifecycle } from '@/lib/agent-session/launch/structured-agent-session-launch-registry'
import { subscribeStructuredAgentLaunchStatus } from '@/lib/agent-session/launch/structured-agent-session-launch-state-store'
import { getStructuredAgentSessionLaunchFailedAt } from '@/lib/agent-session/launch/structured-agent-session-launch-failed-at'
import { useAppStore } from '@/store'
import type { AppState } from '@/store/types'
import type { StructuredChatCompanionWrite } from '@/store/slices/agent-status/structured-sessions/structured-chat-companion-writes'
import { structuredAgentSessionTargetForHost } from '@/runtime/native-chat/session-ownership/structured-agent-session-owner'
import {
  getStructuredAgentSessionStatusFeed,
  structuredAgentSessionStatusFeedKey
} from '@/runtime/native-chat/status/structured-agent-session-status-feed'
import {
  getStructuredAgentSessionTabsInWorkspace,
  structuredTabsShowingConversation,
  type StructuredTab
} from './structured-agent-session-tabs'
import { readTabMapChanges } from '@/store/record-transitions/keyed-record-change-reads'
import {
  readBotBackgroundSessionTabs,
  subscribeBotBackgroundSessionTabs,
  withBotSessions
} from '../../../bots/bot-background-sessions'
import {
  createTabOwnerCache,
  ownerInputChanged,
  ownerInputs
} from './structured-agent-session-tab-owner-cache'
import {
  createStructuredSessionMembership,
  type HostGroup,
  type Member,
  type ProjectionInput,
  sameSemanticTab,
  sameCapturedInput,
  sameStatusInput
} from './structured-agent-session-status-membership'
import {
  sessionMembers,
  subscribeHostGroupStatus
} from './structured-agent-session-preview-coalescing'

function installStatusProjection(): () => void {
  const membership = createStructuredSessionMembership()
  const { members, membersByTabId, legacy } = membership
  const retired = new Set<Member>()
  let tabs: readonly StructuredTab[] | null = null
  let tabsSource: AppState['unifiedTabsByWorktree'] | null = null
  // A bot's tabless sessions stand in for tabs; a change to them reconciles from the whole list.
  let botTabsSource: readonly StructuredTab[] | null = null
  const groups = new Map<string, HostGroup>()
  const queue: (() => void)[] = []
  const ownerForTab = createTabOwnerCache()
  let disposed = false
  let draining = false
  const report = (error: unknown, context: unknown): void => {
    try {
      console.warn('[structured-session-status] projection failed', context, error)
    } catch {
      // Diagnostics cannot interrupt the host's reconnect stack.
    }
  }
  const boundary = (operation: () => void, context: unknown = 'membership'): void => {
    try {
      operation()
    } catch (error) {
      report(error, context)
    }
  }
  const enqueue = (operation: () => void, context: unknown = 'cleanup'): void => {
    queue.push(() => boundary(operation, context))
    if (draining) {
      return
    }
    draining = true
    try {
      while (queue.length) {
        const next = queue.shift()
        if (next) {
          next()
        }
      }
    } finally {
      draining = false
    }
  }
  const current = (input: ProjectionInput): boolean => {
    if (disposed || members.get(input.member.paneKey) !== input.member) {
      return false
    }
    const tab = input.member.tab
    const target =
      tab && structuredAgentSessionTargetForHost(ownerForTab(useAppStore.getState(), tab))
    return (
      sameSemanticTab(tab, input.tab) &&
      (target ? structuredAgentSessionStatusFeedKey(target) : null) === input.member.hostKey
    )
  }
  const companions = (input: ProjectionInput, writes: StructuredChatCompanionWrite[]): void => {
    const { member, tab, sleptAt, directory } = input
    if (
      current(input) &&
      (member.group ? member.group.feed.getSessionSleepState(tab.entityId) : null) === sleptAt
    ) {
      writes.push({ kind: 'slept-at', paneKey: member.paneKey, sleptAt })
    }
    if (!current(input)) {
      return
    }
    const latestDirectory = member.group?.feed.getSnapshot().get(tab.entityId)?.launchDirectory
    if (latestDirectory !== directory) {
      return
    }
    writes.push(
      directory
        ? {
            kind: 'launch-directory',
            tabId: tab.id,
            sessionId: tab.entityId,
            launchDirectory: directory
          }
        : { kind: 'clear-launch-directory', tabId: tab.id, sessionId: tab.entityId }
    )
  }
  const project = (inputs: ProjectionInput[]): void => {
    const removed = [...retired]
    const dirty = inputs.filter(
      (input) => current(input) && !sameStatusInput(input.member.status, input)
    )
    const clean = (): void => {
      const writes: StructuredChatCompanionWrite[] = []
      for (const old of removed) {
        if (!members.has(old.paneKey)) {
          writes.push({ kind: 'slept-at', paneKey: old.paneKey, sleptAt: undefined })
        }
        const replacements = membersByTabId.get(old.tab.id) ?? []
        if (![...replacements].some((member) => member.tab.entityId === old.tab.entityId)) {
          writes.push({
            kind: 'clear-launch-directory',
            tabId: old.tab.id,
            sessionId: old.tab.entityId
          })
        }
      }
      for (const input of inputs) {
        companions(input, writes)
      }
      useAppStore.getState().applyStructuredChatCompanionWrites(writes)
      for (const old of removed) {
        retired.delete(old)
      }
    }
    if (dirty.length || removed.length) {
      useAppStore.getState().transactAgentStatuses((transaction) => {
        for (const old of removed) {
          if (!members.has(old.paneKey)) {
            transaction.getState().removeAgentStatus(old.paneKey)
          }
        }
        for (const input of dirty) {
          if (current(input)) {
            projectStatus(transaction, input.tab, input.summary, input.observation, input.failedAt)
          }
        }
        transaction.afterCommit(clean)
      })
      for (const input of dirty) {
        if (current(input)) {
          input.member.status = input
        }
      }
    } else {
      clean()
    }
    // Mark consumed only after a normal return: a throwing commit leaves the input for the next emission to retry.
    for (const input of inputs) {
      input.member.captured = input
      membership.settle(input.member)
    }
  }
  const publish = (inputs: ProjectionInput[]): void => {
    try {
      project(inputs)
    } catch (error) {
      for (const input of inputs) {
        if (current(input)) {
          membership.owe(input.member)
        }
      }
      throw error
    }
  }
  const burst = createStructuredSessionStatusBurst(publish, enqueue)
  const activateGroups = (): void => {
    for (const [hostKey, group] of groups) {
      if (groups.get(hostKey) === group && group.members.size && !group.release) {
        const release = group.feed.activate()
        if (disposed || groups.get(hostKey) !== group || !group.members.size) {
          release()
        } else {
          group.release = release
        }
      }
    }
  }
  const capture = (selected: Iterable<Member>): void => {
    const inputs: ProjectionInput[] = []
    for (const member of selected) {
      const { tab, group } = member
      const summary = group?.feed.getSnapshot().get(tab.entityId) ?? null
      const input: ProjectionInput = {
        member,
        tab,
        summary,
        observation: group?.feed.getSessionObservation(tab.entityId) ?? 'unverifiable',
        failedAt:
          group &&
          getStructuredAgentSessionLaunchLifecycle(tab.worktreeId, tab.entityId) === 'failed'
            ? (getStructuredAgentSessionLaunchFailedAt(tab.entityId) ?? tab.createdAt)
            : null,
        sleptAt: group ? group.feed.getSessionSleepState(tab.entityId) : null,
        directory: summary?.launchDirectory
      }
      // Launch ticks and full host ticks carry every member; skip the unchanged ones.
      if (!sameCapturedInput(burst.peek(member) ?? member.captured, input)) {
        inputs.push(input)
      } else {
        membership.settle(member)
      }
    }
    enqueue(
      () => {
        try {
          activateGroups()
          burst.add(inputs.filter(current))
        } catch (error) {
          for (const input of inputs) {
            if (current(input)) {
              membership.owe(input.member)
            }
          }
          throw error
        }
      },
      inputs.map(({ member }) => ({ host: member.hostKey, paneKey: member.paneKey }))
    )
  }
  const withOwed = (selected: Iterable<Member>) => membership.withDebt(selected, groups.values())
  const groupFor = (
    state: AppState,
    tab: StructuredTab
  ): { hostKey: string | null; group: HostGroup | null } => {
    const target = structuredAgentSessionTargetForHost(ownerForTab(state, tab))
    const hostKey = target ? structuredAgentSessionStatusFeedKey(target) : null
    const existing = hostKey ? groups.get(hostKey) : undefined
    if (existing || !target || !hostKey) {
      return { hostKey, group: existing ?? null }
    }
    const feed = getStructuredAgentSessionStatusFeed(target)
    const created: HostGroup = {
      members: new Set(),
      membersBySession: new Map(),
      owed: new Set(),
      feed,
      unsubscribe: () => {}
    }
    groups.set(hostKey, created)
    created.unsubscribe = subscribeHostGroupStatus(
      created,
      (due) => boundary(() => !disposed && groups.get(hostKey) === created && capture(due)),
      (selected) => boundary(() => !disposed && capture(selected ?? created.members))
    )
    return { hostKey, group: created }
  }
  const place = (state: AppState, tab: StructuredTab, paneKey: string, changed: Set<Member>) => {
    const { hostKey, group } = groupFor(state, tab)
    const old = members.get(paneKey)
    const member = membership.place(tab, paneKey, hostKey, group)
    if (old && members.get(paneKey) !== old) {
      burst.forget(old)
    }
    if (member) {
      changed.add(member)
    }
  }
  // Cold path (bootstrap, hydration, unannotated replacement): the whole projected chat list.
  const reconcileFromSnapshot = (
    source: AppState['unifiedTabsByWorktree'],
    placeTab: (tab: StructuredTab, paneKey: string) => void
  ): Member[] => {
    const nextTabs = withBotSessions(source)
    if (nextTabs === tabs) {
      return []
    }
    const retiring = membership.reconcileTabs(nextTabs, null, placeTab)
    tabs = nextTabs
    return retiring
  }
  const reconcile = (ownersChanged: boolean): void => {
    const state = useAppStore.getState()
    const source = state.unifiedTabsByWorktree
    const changed = new Set<Member>()
    const retiring: Member[] = []
    const placeTab = (tab: StructuredTab, paneKey: string) => place(state, tab, paneKey, changed)
    const botTabs = readBotBackgroundSessionTabs()
    if (source !== tabsSource || botTabs !== botTabsSource) {
      const changes =
        tabsSource && botTabs === botTabsSource ? readTabMapChanges(source, tabsSource) : null
      if (changes?.kind === 'addressed') {
        const listed = [...changes.workspaceIds].flatMap((workspaceId) => [
          ...getStructuredAgentSessionTabsInWorkspace(source, workspaceId)
        ])
        retiring.push(
          ...membership.reconcileTabs(listed, changes.tabIds, placeTab, (paneKey) =>
            structuredTabsShowingConversation(source, paneKey)
          )
        )
        tabs = null
      } else {
        retiring.push(...reconcileFromSnapshot(source, placeTab))
      }
    }
    for (const member of retiring) {
      burst.forget(member)
      membership.detach(member)
      retired.add(member)
    }
    // Advanced only after a normal return, so a throwing pass is retried by the next tab write.
    tabsSource = source
    botTabsSource = botTabs
    if (ownersChanged) {
      for (const member of legacy) {
        place(state, member.tab, member.paneKey, changed)
      }
    }
    for (const [key, group] of groups) {
      if (groups.get(key) === group && !group.members.size) {
        groups.delete(key)
        group.unsubscribe()
        group.release?.()
      }
    }
    // Existing projection or retirement debt drains on any reconciliation, not only on new changes.
    if (changed.size || retired.size || membership.hasDebt(groups.values())) {
      enqueue(() => {
        activateGroups()
        capture(withOwed(changed))
      })
    }
  }
  // Subscribed first so a closed chat's stand-in exists before the tab write retires its pane.
  const unsubscribeBackground = subscribeBotBackgroundSessionTabs(() =>
    boundary(() => !disposed && reconcile(false))
  )
  const unsubscribeApp = useAppStore.subscribe((state: AppState, previous: AppState) => {
    if (disposed) {
      return
    }
    const ownersChanged = ownerInputs.some((key) => ownerInputChanged(state, previous, key))
    if (ownersChanged || useAppStore.getState().unifiedTabsByWorktree !== tabsSource) {
      boundary(() => reconcile(ownersChanged))
    }
  })
  const unsubscribeLaunch = subscribeStructuredAgentLaunchStatus((sessionIds) =>
    boundary(() => {
      if (disposed) {
        return
      }
      // Full resync: the writer could not name its sessions.
      if (sessionIds === null) {
        capture(members.values())
        return
      }
      capture(
        withOwed([...groups.values()].flatMap((group) => [...sessionMembers(group, sessionIds)]))
      )
    })
  )
  boundary(() => reconcile(false))
  return () => {
    disposed = true
    burst.dispose()
    unsubscribeApp()
    unsubscribeLaunch()
    unsubscribeBackground()
    for (const group of groups.values()) {
      group.members.clear()
      group.unsubscribe()
      boundary(() => group.release?.())
    }
    groups.clear()
    for (const member of members.values()) {
      retired.add(member)
    }
    membership.clear()
    enqueue(() => project([]))
  }
}

export function StructuredAgentSessionStatusBridge(): null {
  useEffect(installStatusProjection, [])
  return null
}
