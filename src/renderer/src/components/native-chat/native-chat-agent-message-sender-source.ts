import { useCallback, useMemo, useSyncExternalStore } from 'react'
import { useAppStore } from '@/store'
import type { AppState } from '@/store/types'
import {
  createWorktreeAgentRowsCache,
  startWorktreeAgentRowsCachePass,
  selectWorktreeAgentRowsCached
} from '@/components/dashboard/worktree-agent-rows-cache'
import { createWorktreeAgentFreshnessSelector } from '@/components/sidebar/worktree-agent-freshness-selector'
import { selectRuntimeAgentOrchestrationForWorktree } from '@/components/sidebar/worktree-agent-row-selectors'
import { agentRowDisplayDotState } from '@/lib/agent-row-dot-state'
import { resolveRowProgramStatus } from '@/lib/program-status/agent-row-presentation'
import {
  agentMessageSenderView,
  type AgentMessageSenderView
} from '../../../../shared/agent-session/agent-message-presentation'

const EMPTY_VIEW: AgentMessageSenderView = Object.freeze({})
export type SenderLocation = {
  host: string
  worktreeId: string
  paneKey: string
  agentType?: AgentMessageSenderView['agentType']
}
type LocateSender = (state: AppState) => SenderLocation | undefined

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

/** Share the sidebar projection before notifying cards; only subscription leases retain a source. */
export function useAgentMessageSenderSource(locate: LocateSender): AgentMessageSenderView {
  const locates = useMemo(() => [locate], [locate])
  return useAgentMessageSenderSources(locates)[0]
}

function releaseSource(key: string, source: Source): void {
  if (--source.leases === 0) {
    subscribedSources.delete(key)
    source.dispose()
  }
}

/** Resolve several senders under one store subscription; unchanged views keep their identity. */
export function useAgentMessageSenderSources(
  locates: readonly LocateSender[]
): readonly AgentMessageSenderView[] {
  const selected = useMemo(() => {
    let previous: readonly AgentMessageSenderView[] = []
    return (state: AppState) => {
      let changed = previous.length !== locates.length
      const next = locates.map((locate, index) => {
        const location = locate(state)
        const view = location
          ? agentMessageSenderView(
              readSource(state, location).read(state, location.paneKey),
              location.agentType
            )
          : EMPTY_VIEW
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
  }, [locates])
  const subscribe = useCallback(
    (notify: () => void) => {
      const leases = new Map<string, Source>()
      const update = () => {
        const state = useAppStore.getState()
        const located = new Map<string, SenderLocation>()
        for (const locate of locates) {
          const location = locate(state)
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
    [locates, selected]
  )
  const getSnapshot = useCallback(() => selected(useAppStore.getState()), [selected])
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}
