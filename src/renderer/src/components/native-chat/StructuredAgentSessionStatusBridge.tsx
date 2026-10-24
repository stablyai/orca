import { useEffect } from 'react'
import type { AgentSessionStatusSummary } from '../../../../shared/agent-session-wire'
import { structuredAgentSessionPaneKey } from '../../../../shared/structured-agent-session-projection'
import { projectStatus } from './structured-agent-session-status-projection'
import {
  getStructuredAgentSessionLaunchLifecycle,
  subscribeStructuredAgentLaunchStatus
} from '@/lib/structured-agent-session-launch-registry'
import { getStructuredAgentSessionLaunchFailedAt } from '@/lib/structured-agent-session-launch-failed-at'
import { useAppStore } from '@/store'
import type { AppState } from '@/store/types'
import type { WorktreeRuntimeOwnerState } from '@/lib/worktree-runtime-owner-state'
import {
  structuredAgentSessionOwnerForTab,
  structuredAgentSessionTargetForHost
} from '@/runtime/structured-agent-session-owner'
import {
  getStructuredAgentSessionStatusFeed,
  structuredAgentSessionStatusFeedKey,
  type StructuredAgentSessionStatusFeedOwner
} from '@/runtime/structured-agent-session-status-feed'
import { getStructuredAgentSessionTabs, type StructuredTab } from './structured-agent-session-tabs'

// Re-exported so the bridge stays the one import site its consumers already know.
export { getStructuredAgentSessionTabs } from './structured-agent-session-tabs'

export {
  useStructuredAgentSessionStatusSummary,
  useStructuredAgentSessionOptionStamp,
  useStructuredAgentSessionHostExecutionPhase,
  useStructuredAgentSessionHostStopping,
  useStructuredAgentSessionHostExecution,
  useStructuredAgentSessionRewindBlockedReason
} from './structured-agent-session-status-hooks'

type HostGroup = {
  members: Member[]
  feed: StructuredAgentSessionStatusFeedOwner
  unsubscribe: () => void
  release?: () => void
}
type ProjectionInput = {
  tab: StructuredTab
  member: Member
  summary: AgentSessionStatusSummary | null
  observation: 'live' | 'unverifiable'
  failedAt: number | null
  sleptAt: number | null | undefined
  directory: string | undefined
}
type Member = {
  paneKey: string
  tab: StructuredTab
  hostKey: string | null
  group: HostGroup | null
  status?: ProjectionInput
}
const ownerInputs: readonly (keyof WorktreeRuntimeOwnerState)[] = [
  'repos',
  'settings',
  'worktreesByRepo',
  'detectedWorktreesByRepo',
  'folderWorkspaces',
  'projectGroups',
  'restoredRuntimeHostIdByWorkspaceSessionKey',
  'activeWorktreeId',
  'activeWorkspaceExecutionHostId',
  'runtimeEnvironments',
  'runtimeEnvironmentCatalogHydrated',
  'removedRuntimeEnvironmentIds'
]

function sameStatusInput(previous: ProjectionInput | undefined, next: ProjectionInput): boolean {
  return (
    previous?.tab === next.tab &&
    previous.summary === next.summary &&
    previous.observation === next.observation &&
    previous.failedAt === next.failedAt
  )
}

function installStatusProjection(): () => void {
  const members = new Map<string, Member>()
  const membersByTabId = new Map<string, Member>()
  const retired = new Set<Member>()
  const groups = new Map<string, HostGroup>()
  const queue: (() => void)[] = []
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
    const state = useAppStore.getState()
    const tab = input.member.tab
    const target =
      tab && structuredAgentSessionTargetForHost(structuredAgentSessionOwnerForTab(state, tab))
    return (
      tab === input.tab &&
      (target ? structuredAgentSessionStatusFeedKey(target) : null) === input.member.hostKey
    )
  }
  const companions = (input: ProjectionInput): void => {
    const { member, tab, sleptAt, directory } = input
    if (
      current(input) &&
      (member.group ? member.group.feed.getSessionSleepState(tab.entityId) : null) === sleptAt
    ) {
      const store = useAppStore.getState()
      if (store.structuredChatSleptAtByPaneKey[member.paneKey] !== sleptAt) {
        store.setStructuredChatSleptAt(member.paneKey, sleptAt)
      }
    }
    if (!current(input)) {
      return
    }
    const latestDirectory =
      member.hostKey === 'local'
        ? member.group?.feed.getSnapshot().get(tab.entityId)?.launchDirectory
        : undefined
    if (latestDirectory !== directory) {
      return
    }
    const store = useAppStore.getState()
    const pin = store.structuredSessionLaunchDirectoryByTabId[tab.id]
    if (
      directory
        ? pin?.sessionId !== tab.entityId || pin.launchDirectory !== directory
        : pin?.sessionId === tab.entityId
    ) {
      if (directory) {
        store.setStructuredSessionLaunchDirectory(tab.id, tab.entityId, directory)
      } else {
        store.clearStructuredSessionLaunchDirectory(tab.id, tab.entityId)
      }
    }
  }
  const project = (inputs: ProjectionInput[]): void => {
    const removed = [...retired]
    const dirty = inputs.filter(
      (input) => current(input) && !sameStatusInput(input.member.status, input)
    )
    const clean = (): void => {
      for (const old of removed) {
        if (!members.has(old.paneKey)) {
          useAppStore.getState().setStructuredChatSleptAt(old.paneKey, undefined)
        }
        const replacement = membersByTabId.get(old.tab.id)
        if (!replacement || replacement.tab.entityId !== old.tab.entityId) {
          useAppStore.getState().clearStructuredSessionLaunchDirectory(old.tab.id, old.tab.entityId)
        }
        retired.delete(old)
      }
      for (const input of inputs) {
        companions(input)
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
  }
  const activateGroups = (): void => {
    for (const [hostKey, group] of groups) {
      if (groups.get(hostKey) === group && group.members.length && !group.release) {
        const release = group.feed.activate()
        if (disposed || groups.get(hostKey) !== group || !group.members.length) {
          release()
        } else {
          group.release = release
        }
      }
    }
  }
  const capture = (selected: Iterable<Member>): void => {
    const inputs = [...selected].map((member): ProjectionInput => {
      const { tab, group } = member
      const summary = group?.feed.getSnapshot().get(tab.entityId) ?? null
      return {
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
        directory: member.hostKey === 'local' ? summary?.launchDirectory : undefined
      }
    })
    enqueue(
      () => {
        activateGroups()
        project(inputs)
      },
      inputs.map(({ member }) => ({ host: member.hostKey, paneKey: member.paneKey }))
    )
  }
  const reconcile = (): void => {
    const state = useAppStore.getState()
    const next = new Map<string, Member>()
    for (const tab of getStructuredAgentSessionTabs(state.unifiedTabsByWorktree)) {
      const paneKey = structuredAgentSessionPaneKey(tab.id, tab.entityId)
      const target = structuredAgentSessionTargetForHost(
        structuredAgentSessionOwnerForTab(state, tab)
      )
      const hostKey = target ? structuredAgentSessionStatusFeedKey(target) : null
      let group = hostKey ? groups.get(hostKey) : undefined
      if (!group && target && hostKey) {
        const feed = getStructuredAgentSessionStatusFeed(target)
        const created: HostGroup = { members: [], feed, unsubscribe: () => {} }
        groups.set(hostKey, created)
        created.unsubscribe = feed.subscribe(() =>
          boundary(() => {
            if (!disposed) {
              capture(created.members)
            }
          })
        )
        group = created
      }
      const old = members.get(paneKey)
      const member: Member =
        old?.group === (group ?? null)
          ? old
          : {
              paneKey,
              tab,
              hostKey,
              group: group ?? null
            }
      member.tab = tab
      next.set(paneKey, member)
    }
    for (const member of members.values()) {
      if (!next.has(member.paneKey)) {
        retired.add(member)
      }
    }
    members.clear()
    membersByTabId.clear()
    for (const group of groups.values()) {
      group.members = []
    }
    for (const [key, member] of next) {
      members.set(key, member)
      membersByTabId.set(member.tab.id, member)
      member.group?.members.push(member)
    }
    for (const [key, group] of groups) {
      if (groups.get(key) === group && !group.members.length) {
        groups.delete(key)
        group.members = []
        group.unsubscribe()
        group.release?.()
      }
    }
    enqueue(() => {
      activateGroups()
      capture(members.values())
    })
  }
  const unsubscribeApp = useAppStore.subscribe((state: AppState, previous: AppState) => {
    if (
      !disposed &&
      (state.unifiedTabsByWorktree !== previous.unifiedTabsByWorktree ||
        ownerInputs.some((key) => state[key] !== previous[key]))
    ) {
      boundary(reconcile)
    }
  })
  const unsubscribeLaunch = subscribeStructuredAgentLaunchStatus(() =>
    boundary(() => {
      if (!disposed) {
        capture(members.values())
      }
    })
  )
  boundary(reconcile)
  return () => {
    disposed = true
    unsubscribeApp()
    unsubscribeLaunch()
    for (const group of groups.values()) {
      group.members = []
      group.unsubscribe()
      boundary(() => group.release?.())
    }
    groups.clear()
    for (const member of members.values()) {
      retired.add(member)
    }
    members.clear()
    membersByTabId.clear()
    enqueue(() => project([]))
  }
}

export function StructuredAgentSessionStatusBridge(): null {
  useEffect(installStatusProjection, [])
  return null
}
