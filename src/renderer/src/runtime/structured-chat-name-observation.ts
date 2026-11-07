import { useAppViewExternalStore } from '@/store/app-state-view'
import { useMemo } from 'react'
import { shallow } from 'zustand/shallow'
import type { ExecutionHostId } from '../../../shared/execution-host'
import { useAppStore } from '@/store'
import { getStructuredAgentSessionTabs } from '@/components/native-chat/structured-agent-session-tabs'
import {
  structuredAgentSessionOwnerInputs,
  structuredAgentSessionTargetForHost
} from './structured-agent-session-owner'
import { getStructuredAgentSessionStatusFeed } from './structured-agent-session-status-feed'
import {
  resolveStructuredChatTabName,
  type StructuredChatTabName,
  type StructuredChatTabNames
} from './structured-chat-tab-name'
import { isUnifiedTabOwnedByWorktree } from '@/lib/unified-tab-host-ownership'
import type { Tab } from '../../../shared/tab-types'
import type { Worktree } from '../../../shared/worktree/types'

const listeners = new Set<() => void>()
let snapshot: StructuredChatTabNames = new Map()
let inputs: unknown[] = []
let nameMaps = new Map<ExecutionHostId, unknown>()
let stopObserving: (() => void) | undefined
export function getStructuredChatTabNames(): StructuredChatTabNames {
  const state = useAppStore.getState()
  const nextInputs = [state.unifiedTabsByWorktree, ...structuredAgentSessionOwnerInputs(state)]
  const nextMaps = new Map<ExecutionHostId, unknown>()
  for (const owner of nameMaps.keys()) {
    const target = structuredAgentSessionTargetForHost(owner)
    if (target) {
      nextMaps.set(owner, getStructuredAgentSessionStatusFeed(target).getNamingSnapshot())
    }
  }
  if (shallow(inputs, nextInputs) && shallow(nameMaps, nextMaps)) {
    return snapshot
  }
  const next = new Map(
    getStructuredAgentSessionTabs(state.unifiedTabsByWorktree).map((tab) => {
      const value = resolveStructuredChatTabName(tab, state)
      const target = structuredAgentSessionTargetForHost(value.owner)
      if (value.owner && target) {
        nextMaps.set(value.owner, getStructuredAgentSessionStatusFeed(target).getNamingSnapshot())
      }
      return [tab, value] as const
    })
  )
  const owners = new Set([...next.values()].map((value) => value.owner))
  for (const owner of nextMaps.keys()) {
    if (!owners.has(owner)) {
      nextMaps.delete(owner)
    }
  }
  inputs = nextInputs
  nameMaps = nextMaps
  if (
    next.size !== snapshot.size ||
    [...next].some(([tab, value]) => {
      const previous = snapshot.get(tab)
      return (
        !previous ||
        previous.owner !== value.owner ||
        previous.sessionId !== value.sessionId ||
        previous.savedName !== value.savedName
      )
    })
  ) {
    snapshot = next
  }
  return snapshot
}

function observe(): () => void {
  const feeds = new Map<ExecutionHostId, () => void>()
  let published = getStructuredChatTabNames()
  const notice = () => {
    const next = getStructuredChatTabNames()
    if (published !== next) {
      published = next
      listeners.forEach((listener) => listener())
    }
  }
  const reconcile = () => {
    const owners = new Set([...getStructuredChatTabNames().values()].map((value) => value.owner))
    for (const [owner, stop] of feeds) {
      if (!owners.has(owner)) {
        stop()
        feeds.delete(owner)
      }
    }
    for (const owner of owners) {
      const target = structuredAgentSessionTargetForHost(owner)
      if (!owner || !target || feeds.has(owner)) {
        continue
      }
      const feed = getStructuredAgentSessionStatusFeed(target)
      let names = feed.getNamingSnapshot()
      const stop = feed.subscribe(() => {
        const next = feed.getNamingSnapshot()
        if (names !== next) {
          names = next
          notice()
        }
      })
      const deactivate = feed.activate()
      feeds.set(owner, () => {
        stop()
        deactivate()
      })
    }
    notice()
  }
  const stopStore = useAppStore.subscribe((state, previous) => {
    if (
      state.unifiedTabsByWorktree !== previous.unifiedTabsByWorktree ||
      !shallow(
        structuredAgentSessionOwnerInputs(state),
        structuredAgentSessionOwnerInputs(previous)
      )
    ) {
      reconcile()
    }
  })
  reconcile()
  return () => {
    stopStore()
    feeds.forEach((stop) => stop())
  }
}

export function subscribeStructuredChatTabNames(listener: () => void): () => void {
  listeners.add(listener)
  if (listeners.size === 1) {
    stopObserving = observe()
  }
  return () => {
    listeners.delete(listener)
    if (listeners.size === 0) {
      stopObserving?.()
      stopObserving = undefined
    }
  }
}

type ScopedWorktree = Pick<Worktree, 'hostId' | 'id' | 'runtimeOwnerEnvironmentId'>
type ChatNameEntry = readonly [Tab, StructuredChatTabName]

const NO_AMBIGUOUS_WORKTREES: ReadonlySet<string> = new Set()
const NO_CHAT_NAME_ENTRIES: readonly ChatNameEntry[] = []
// Grouped once per published map, so a scoped read touches only its own workspace's chats.
const entriesByWorktreeByNames = new WeakMap<
  StructuredChatTabNames,
  ReadonlyMap<string, readonly ChatNameEntry[]>
>()

function worktreeChatNameEntries(
  names: StructuredChatTabNames,
  worktree: ScopedWorktree
): ChatNameEntry[] {
  let byWorktree = entriesByWorktreeByNames.get(names)
  if (!byWorktree) {
    const grouped = new Map<string, ChatNameEntry[]>()
    for (const entry of names) {
      const bucket = grouped.get(entry[0].worktreeId)
      if (bucket) {
        bucket.push(entry)
      } else {
        grouped.set(entry[0].worktreeId, [entry])
      }
    }
    byWorktree = grouped
    entriesByWorktreeByNames.set(names, byWorktree)
  }
  // Why the builder's ownership check: a same-id workspace on another host is not this one.
  return (byWorktree.get(worktree.id) ?? NO_CHAT_NAME_ENTRIES).filter(([tab]) =>
    isUnifiedTabOwnedByWorktree(tab, worktree, NO_AMBIGUOUS_WORKTREES)
  )
}

function subscribeNothing(): () => void {
  return () => {}
}

/** One workspace's chat names: a name arriving for another workspace's chat neither re-renders
 *  the caller nor changes the returned map. `tabsKey` is that workspace's tab list, whose identity
 *  changes whenever the map's tab keys do. */
export function useWorktreeStructuredChatTabNames(
  worktree: ScopedWorktree | null,
  tabsKey: unknown,
  enabled: boolean
): StructuredChatTabNames {
  const signature = useAppViewExternalStore(
    enabled && worktree ? subscribeStructuredChatTabNames : subscribeNothing,
    () =>
      enabled && worktree
        ? JSON.stringify(
            worktreeChatNameEntries(getStructuredChatTabNames(), worktree).map(([tab, value]) => [
              tab.id,
              value.savedName
            ])
          )
        : ''
  )
  return useMemo(
    () => new Map(worktree ? worktreeChatNameEntries(getStructuredChatTabNames(), worktree) : []),
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- signature and tabsKey are what change the scoped names.
    [signature, tabsKey, worktree?.id, worktree?.hostId, worktree?.runtimeOwnerEnvironmentId]
  )
}

export function useStructuredChatTabNames(): StructuredChatTabNames {
  return useAppViewExternalStore(
    subscribeStructuredChatTabNames,
    getStructuredChatTabNames,
    getStructuredChatTabNames
  )
}
