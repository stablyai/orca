import { useCallback, useMemo, useSyncExternalStore } from 'react'
import { useAppStore } from '@/store'
import type { AppState } from '@/store/types'
import {
  createWorktreeAgentRowsCache,
  startWorktreeAgentRowsCachePass,
  selectWorktreeAgentRowsCached
} from '@/components/dashboard/rows/worktree-agent-rows-cache'
import { createWorktreeAgentFreshnessSelector } from '@/components/sidebar/workspace-card/activity/worktree-agent-freshness-selector'
import '@/components/sidebar/workspace-card/activity/worktree-agent-row-selectors'
import { selectWorktreeAgentOrchestration as selectRuntimeAgentOrchestrationForWorktree } from '@/components/sidebar/workspace-card/activity/worktree-agent-orchestration-index'
import { agentRowDisplayDotState } from '@/lib/agent-status/presentation/agent-row-dot-state'
import { resolveRowProgramStatus } from '@/lib/program-status/agent-row-presentation'
import {
  agentMessageSenderView,
  type AgentMessageSenderView
} from '../../../../../../shared/agent-session/agent-message-presentation'

const EMPTY_VIEW: AgentMessageSenderView = Object.freeze({})
let rowBuilds = 0
/** Sidebar row sets the card sources built; a leased source reuses its rows across store writes. */
export const agentMessageSenderRowBuildsForTest = () => rowBuilds
export type SenderLocation = {
  /** A fallback endpoint supplies its kind, never an earlier actor's activity. */
  activity?: false
  host: string
  worktreeId: string
  paneKey: string
  agentType?: AgentMessageSenderView['agentType']
}
type LocateSender = (state: AppState) => SenderLocation | undefined
export type SenderLookup = {
  locate: LocateSender
  savedAgent?: AgentMessageSenderView['agentType']
  leaseLocate?: LocateSender
}

function equalView(a: AgentMessageSenderView, b: AgentMessageSenderView): boolean {
  return a.agentType === b.agentType && a.dot === b.dot && a.progress === b.progress
}

function createSource(worktreeId: string) {
  const cache = createWorktreeAgentRowsCache()
  const freshness = createWorktreeAgentFreshnessSelector(worktreeId)
  let snapshot: AppState | undefined
  let rows: ReturnType<typeof selectWorktreeAgentRowsCached> | undefined
  let views = new Map<string, AgentMessageSenderView>()
  return {
    leases: 0,
    dispose() {
      snapshot = undefined
      rows = undefined
      views.clear()
      cache.byWorktree.clear()
      startWorktreeAgentRowsCachePass(cache)
    },
    read(state: AppState, paneKey: string): AgentMessageSenderView | undefined {
      if (snapshot !== state) {
        snapshot = state
        startWorktreeAgentRowsCachePass(cache)
        const next = selectWorktreeAgentRowsCached({
          state,
          worktreeId,
          cache,
          now: Date.now(),
          generation: freshness(state),
          orchestration: selectRuntimeAgentOrchestrationForWorktree(state, worktreeId)
        })
        if (rows !== next) {
          rowBuilds++
          rows = next
          const indexed = new Map<string, AgentMessageSenderView>()
          for (const row of next) {
            if (indexed.has(row.paneKey)) {
              continue
            }
            const { presentation, dotStateOverride } = resolveRowProgramStatus(row)
            const value = {
              agentType: row.agentType,
              dot: dotStateOverride ?? agentRowDisplayDotState(row),
              progress: presentation.progress
            }
            const previous = views.get(row.paneKey)
            indexed.set(row.paneKey, previous && equalView(previous, value) ? previous : value)
          }
          views = indexed
        }
      }
      return views.get(paneKey)
    }
  }
}

type Source = ReturnType<typeof createSource>
const subscribedSources = new Map<string, Source>()
// Uncommitted renders have no registry lease; their snapshot and derived rows can be collected.
const transientSources = new WeakMap<AppState, Map<string, Source>>()
function sourceKey(location: SenderLocation): string {
  return JSON.stringify([location.host, location.worktreeId])
}
function readSource(state: AppState, location: SenderLocation): Source {
  const key = sourceKey(location)
  const subscribed = subscribedSources.get(key)
  if (subscribed) {
    return subscribed
  }
  let sources = transientSources.get(state)
  if (!sources) {
    sources = new Map()
    transientSources.set(state, sources)
  }
  let source = sources.get(key)
  if (!source) {
    source = createSource(location.worktreeId)
    sources.set(key, source)
  }
  return source
}

/** The sidebar row at a located sender, read through the same per-worktree projection cards share. */
export function readAgentMessageSenderRow(
  state: AppState,
  location: SenderLocation
): AgentMessageSenderView | undefined {
  return readSource(state, location).read(state, location.paneKey)
}

function senderRowView(
  state: AppState,
  location: SenderLocation
): AgentMessageSenderView | undefined {
  const row = readSource(state, location).read(state, location.paneKey)
  return location.activity === false ? { agentType: row?.agentType ?? location.agentType } : row
}

/** Share the sidebar projection before notifying cards; only subscription leases retain a source.
 *  `savedAgent`: the kind written on the message, drawn ahead of any live row's guess.
 *  `leaseLocate`: the rows the card reads to decide, also where it then draws none. */
export function useAgentMessageSenderSource(
  locate: LocateSender,
  savedAgent?: AgentMessageSenderView['agentType'],
  leaseLocate: LocateSender = locate
): AgentMessageSenderView {
  const selected = useMemo(() => {
    let previous = EMPTY_VIEW
    return (state: AppState) => {
      const location = locate(state)
      const next = agentMessageSenderView(
        location ? senderRowView(state, location) : undefined,
        savedAgent ?? location?.agentType
      )
      if (!equalView(previous, next)) {
        previous = next
      }
      return previous
    }
  }, [locate, savedAgent])
  return useLeasedSenderSelector(leaseLocate, selected)
}

/** A card selector that may read the located sender's sidebar row: it leases that row's source as
 *  the avatar does, so a store write reuses the projection instead of rebuilding it per read. */
export function useLeasedSenderSelector<T>(
  locate: LocateSender,
  select: (state: AppState) => T
): T {
  const subscribe = useCallback(
    (notify: () => void) => {
      let lease: { key: string; source: Source } | undefined
      const release = () => {
        if (lease && --lease.source.leases === 0) {
          subscribedSources.delete(lease.key)
          lease.source.dispose()
        }
        lease = undefined
      }
      const update = () => {
        const state = useAppStore.getState()
        const location = locate(state)
        const key = location ? sourceKey(location) : undefined
        if (lease?.key !== key) {
          release()
          if (location && key) {
            const source = readSource(state, location)
            transientSources.get(state)?.delete(key)
            source.leases++
            subscribedSources.set(key, source)
            lease = { key, source }
          }
        }
        return select(state)
      }
      let value = update()
      const unsubscribe = useAppStore.subscribe(() => {
        const next = update()
        if (next !== value) {
          value = next
          notify()
        }
      })
      return () => {
        unsubscribe()
        release()
      }
    },
    [locate, select]
  )
  const getSnapshot = useCallback(() => select(useAppStore.getState()), [select])
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}

function releaseSource(key: string, source: Source): void {
  if (--source.leases === 0) {
    subscribedSources.delete(key)
    source.dispose()
  }
}

/** Resolve several senders under one store subscription; unchanged views keep their identity. */
export function useAgentMessageSenderSources(
  lookups: readonly SenderLookup[]
): readonly AgentMessageSenderView[] {
  const selected = useMemo(() => {
    let previous: readonly AgentMessageSenderView[] = []
    return (state: AppState) => {
      let changed = previous.length !== lookups.length
      const next = lookups.map(({ locate, savedAgent }, index) => {
        const location = locate(state)
        const view = agentMessageSenderView(
          location ? senderRowView(state, location) : undefined,
          savedAgent ?? location?.agentType
        )
        const prior = previous[index]
        if (prior && equalView(prior, view)) {
          return prior
        }
        changed = true
        return view
      })
      if (changed) {
        previous = next
      }
      return previous
    }
  }, [lookups])
  const subscribe = useCallback(
    (notify: () => void) => {
      const leases = new Map<string, Source>()
      const update = () => {
        const state = useAppStore.getState()
        const located = new Map<string, SenderLocation>()
        for (const { locate, leaseLocate } of lookups) {
          const location = (leaseLocate ?? locate)(state)
          if (location) {
            located.set(sourceKey(location), location)
          }
        }
        for (const [key, source] of leases) {
          if (!located.has(key)) {
            leases.delete(key)
            releaseSource(key, source)
          }
        }
        for (const [key, location] of located) {
          if (!leases.has(key)) {
            const source = readSource(state, location)
            transientSources.get(state)?.delete(key)
            source.leases++
            subscribedSources.set(key, source)
            leases.set(key, source)
          }
        }
        return selected(state)
      }
      let value = update()
      const unsubscribe = useAppStore.subscribe(() => {
        const next = update()
        if (next !== value) {
          value = next
          notify()
        }
      })
      return () => {
        unsubscribe()
        for (const [key, source] of leases) {
          releaseSource(key, source)
        }
        leases.clear()
      }
    },
    [lookups, selected]
  )
  const getSnapshot = useCallback(() => selected(useAppStore.getState()), [selected])
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}
