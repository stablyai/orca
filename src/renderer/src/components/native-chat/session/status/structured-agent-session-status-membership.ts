import type { AgentSessionStatusSummary } from '../../../../../../shared/agent-session/agent-session-wire'
import type { StructuredAgentSessionStatusFeedOwner } from '@/runtime/native-chat/status/structured-agent-session-status-feed'
import type { StructuredTab } from './structured-agent-session-tabs'

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

/** Which chat tabs the status bridge projects, updated per changed tab rather than rebuilt. */
export function createStructuredSessionMembership() {
  const members = new Map<string, Member>()
  const membersByTabId = new Map<string, Member>()
  /** Unstamped tabs resolve their host from workspace owner inputs; stamped tabs never do. */
  const legacy = new Set<Member>()

  const attach = (member: Member): void => {
    members.set(member.paneKey, member)
    membersByTabId.set(member.tab.id, member)
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
  const detach = (member: Member): void => {
    if (members.get(member.paneKey) === member) {
      members.delete(member.paneKey)
    }
    if (membersByTabId.get(member.tab.id) === member) {
      membersByTabId.delete(member.tab.id)
    }
    legacy.delete(member)
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
    member.tab = tab
    membersByTabId.set(tab.id, member)
    if (tab.executionHostId) {
      legacy.delete(member)
    } else {
      legacy.add(member)
    }
    return semanticChange ? member : null
  }
  const clear = (): void => {
    members.clear()
    membersByTabId.clear()
    legacy.clear()
  }
  return { members, membersByTabId, legacy, place, detach, clear }
}
