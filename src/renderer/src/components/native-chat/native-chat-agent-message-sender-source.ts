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
  const selected = useMemo(() => {
    let previous = EMPTY_VIEW
    return (state: AppState) => {
      const location = locate(state)
      const next = location
        ? agentMessageSenderView(
            readSource(state, location).read(state, location.paneKey),
            location.agentType
          )
        : EMPTY_VIEW
      if (!equalView(previous, next)) {
        previous = next
      }
      return previous
    }
  }, [locate])
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
        release()
      }
    },
    [locate, selected]
  )
  const getSnapshot = useCallback(() => selected(useAppStore.getState()), [selected])
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}
