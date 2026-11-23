import type { AgentSessionStatusSummary } from '../../../../../../shared/agent-session/agent-session-wire'
import type { StructuredAgentSessionStatusFeedOwner } from '@/runtime/native-chat/status/structured-agent-session-status-feed'
import type { StructuredTab } from './structured-agent-session-tabs'
import { chatPaneKey } from '../../../../../../shared/agent-session/view/structured-agent-session-projection'

export type HostGroup = {
  members: Set<Member>
  /** A host tick names its sessions; this finds their tabs without walking every member. */
  membersBySession: Map<string, Set<Member>>
  /** Captured but not yet projected (a throwing commit); retried on this host's next tick. */
  owed: Set<Member>
  feed: StructuredAgentSessionStatusFeedOwner
  unsubscribe: () => void
  release?: () => void
}
export type ProjectionInput = {
  tab: StructuredTab
  member: Member
  summary: AgentSessionStatusSummary | null
  observation: 'live' | 'unverifiable'
  failedAt: number | null
  sleptAt: number | null | undefined
  directory: string | undefined
}
export type Member = {
  paneKey: string
  tab: StructuredTab
  hostKey: string | null
  group: HostGroup | null
  status?: ProjectionInput
  captured?: ProjectionInput
}

/** The tab fields a status projection reads; focus, preview and order metadata never change it. */
export function sameSemanticTab(previous: StructuredTab, next: StructuredTab): boolean {
  return (
    previous === next ||
    (previous.id === next.id &&
      previous.entityId === next.entityId &&
      previous.worktreeId === next.worktreeId &&
      previous.label === next.label &&
      previous.agentSessionAgent === next.agentSessionAgent &&
      previous.createdAt === next.createdAt &&
      previous.executionHostId === next.executionHostId)
  )
}

/** Unchanged feed facts for an unchanged tab cannot change its projection or companions. */
export function sameCapturedInput(
  previous: ProjectionInput | undefined,
  next: ProjectionInput
): boolean {
  return (
    previous !== undefined &&
    sameSemanticTab(previous.tab, next.tab) &&
    previous.summary === next.summary &&
    previous.observation === next.observation &&
    previous.failedAt === next.failedAt &&
    previous.sleptAt === next.sleptAt &&
    previous.directory === next.directory
  )
}

export function sameStatusInput(
  previous: ProjectionInput | undefined,
  next: ProjectionInput
): boolean {
  return (
    previous !== undefined &&
    sameSemanticTab(previous.tab, next.tab) &&
    previous.summary === next.summary &&
    previous.observation === next.observation &&
    previous.failedAt === next.failedAt
  )
}

/** Which chat tabs the status bridge projects, updated per changed tab rather than rebuilt. */
export function createStructuredSessionMembership() {
  const members = new Map<string, Member>()
  /** Every member per tab; a tab rebound to another session briefly has two until the old retires. */
  const membersByTabId = new Map<string, Set<Member>>()
  const indexTab = (member: Member): void => {
    const tabMembers = membersByTabId.get(member.tab.id)
    if (tabMembers) {
      tabMembers.add(member)
    } else {
      membersByTabId.set(member.tab.id, new Set([member]))
    }
  }
  /** Unstamped tabs resolve their host from workspace owner inputs; stamped tabs never do. */
  const legacy = new Set<Member>()
  /** Projection debt of members no host feed owns (SSH, unresolved); grouped debt lives on the group. */
  const ungroupedOwed = new Set<Member>()
  const owe = (member: Member): void => {
    if (member.group) {
      member.group.owed.add(member)
    } else {
      ungroupedOwed.add(member)
    }
  }
  const settle = (member: Member): void => {
    member.group?.owed.delete(member)
    ungroupedOwed.delete(member)
  }
  const withDebt = (selected: Iterable<Member>, groups: Iterable<HostGroup>): Set<Member> => {
    const result = new Set([...selected, ...ungroupedOwed])
    for (const group of groups) {
      group.owed.forEach((member) => result.add(member))
    }
    return result
  }
  const hasDebt = (groups: Iterable<HostGroup>): boolean =>
    ungroupedOwed.size > 0 || [...groups].some((group) => group.owed.size > 0)

  const attach = (member: Member): void => {
    members.set(member.paneKey, member)
    indexTab(member)
    const group = member.group
    if (group) {
      group.members.add(member)
      const sessionMembers = group.membersBySession.get(member.tab.entityId)
      if (sessionMembers) {
        sessionMembers.add(member)
      } else {
        group.membersBySession.set(member.tab.entityId, new Set([member]))
      }
    }
  }
  const unindexTab = (member: Member): void => {
    const tabMembers = membersByTabId.get(member.tab.id)
    tabMembers?.delete(member)
    if (tabMembers && !tabMembers.size) {
      membersByTabId.delete(member.tab.id)
    }
  }
  const detach = (member: Member): void => {
    if (members.get(member.paneKey) === member) {
      members.delete(member.paneKey)
    }
    unindexTab(member)
    legacy.delete(member)
    ungroupedOwed.delete(member)
    const group = member.group
    if (group) {
      group.members.delete(member)
      group.owed.delete(member)
      const sessionMembers = group.membersBySession.get(member.tab.entityId)
      sessionMembers?.delete(member)
      if (sessionMembers && !sessionMembers.size) {
        group.membersBySession.delete(member.tab.entityId)
      }
    }
  }
  /** Same host keeps the member, null when nothing it projects changed; a new host rebinds the pane. */
  const place = (
    tab: StructuredTab,
    paneKey: string,
    hostKey: string | null,
    group: HostGroup | null
  ): Member | null => {
    const old = members.get(paneKey)
    let member: Member
    let semanticChange = true
    if (old?.group === group) {
      if (old.tab === tab) {
        return null
      }
      semanticChange = !sameSemanticTab(old.tab, tab)
      member = old
    } else {
      if (old) {
        detach(old)
      }
      member = { paneKey, tab, hostKey, group }
      attach(member)
    }
    // A conversation's pane key outlives its tab: re-file a reused member under its new tab id.
    const retabbed = member.tab.id !== tab.id
    if (retabbed) {
      unindexTab(member)
    }
    member.tab = tab
    if (retabbed) {
      indexTab(member)
    }
    if (tab.executionHostId) {
      legacy.delete(member)
    } else {
      legacy.add(member)
    }
    if (!semanticChange) {
      return null
    }
    // Owed from attach or change on, so a pass that throws before capturing still retries it.
    owe(member)
    return member
  }
  /** Places listed tabs that changed and returns members no longer listed: all of them, or within
   *  `tabIds`, where `showing` names the open tabs, in any workspace, still showing a conversation. */
  const reconcileTabs = (
    listedTabs: Iterable<StructuredTab>,
    tabIds: ReadonlySet<string> | null,
    placeTab: (tab: StructuredTab, paneKey: string) => void,
    showing?: (paneKey: string) => Iterable<StructuredTab>
  ): Member[] => {
    const listed = new Set<string>()
    const tabs = [...listedTabs]
    for (const tab of tabs) {
      if (tabIds && !tabIds.has(tab.id)) {
        continue
      }
      const paneKey = chatPaneKey(tab.entityId)
      // One member per conversation: the first listed tab holds it, so passes don't flip it.
      if (listed.has(paneKey)) {
        continue
      }
      listed.add(paneKey)
      if (members.get(paneKey)?.tab !== tab) {
        placeTab(tab, paneKey)
      }
    }
    const candidates = tabIds
      ? [...tabIds].flatMap((tabId) => [...(membersByTabId.get(tabId) ?? [])])
      : [...members.values()]
    const orphaned = new Set(
      candidates.filter((member) => !listed.has(member.paneKey)).map((m) => m.paneKey)
    )
    // A closed tab's conversation that another open tab still shows moves there instead of retiring.
    if (tabIds && showing) {
      for (const paneKey of orphaned) {
        for (const tab of showing(paneKey)) {
          if (!tabIds.has(tab.id)) {
            listed.add(paneKey)
            placeTab(tab, paneKey)
            break
          }
        }
      }
    }
    return candidates.filter((member) => !listed.has(member.paneKey))
  }
  const clear = (): void => {
    members.clear()
    membersByTabId.clear()
    legacy.clear()
    ungroupedOwed.clear()
  }
  return {
    members,
    membersByTabId,
    legacy,
    owe,
    settle,
    withDebt,
    hasDebt,
    place,
    detach,
    reconcileTabs,
    clear
  }
}
