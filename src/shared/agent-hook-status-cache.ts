import {
  clearPaneCacheState,
  type AgentHookEventPayload,
  type HookListenerState
} from './agent-hook-listener'
import { AGENT_STATUS_STALE_AFTER_MS } from './agent-status-types'

export const MAX_AGENT_HOOK_STATUS_CACHE_PANES = 500

export type AgentHookStatusCacheEviction = {
  paneKey: string
  entry: AgentHookEventPayload
}

export function upsertBoundedAgentHookStatus(
  state: HookListenerState,
  entry: AgentHookEventPayload,
  options: { maxPanes?: number; now?: number } = {}
): AgentHookStatusCacheEviction[] {
  const maxPanes = options.maxPanes ?? MAX_AGENT_HOOK_STATUS_CACHE_PANES
  if (!Number.isSafeInteger(maxPanes) || maxPanes < 1) {
    throw new RangeError('Agent hook status cache limit must be a positive safe integer')
  }

  state.lastStatusByPaneKey.delete(entry.paneKey)
  state.lastStatusByPaneKey.set(entry.paneKey, entry)
  const evicted: AgentHookStatusCacheEviction[] = []
  const now = options.now ?? Date.now()
  while (state.lastStatusByPaneKey.size > maxPanes) {
    const paneKey = selectEvictionCandidate(state, entry.paneKey, now)
    if (!paneKey) {
      break
    }
    const cached = state.lastStatusByPaneKey.get(paneKey)
    if (!cached) {
      break
    }
    evicted.push({ paneKey, entry: cached })
    clearPaneCacheState(state, paneKey)
  }
  return evicted
}

function selectEvictionCandidate(
  state: HookListenerState,
  currentPaneKey: string,
  now: number
): string | undefined {
  let oldestFallback: string | undefined
  for (const [paneKey, entry] of state.lastStatusByPaneKey) {
    if (paneKey === currentPaneKey) {
      continue
    }
    oldestFallback ??= paneKey
    if (entry.payload.state === 'done' || isStaleStatus(entry, now)) {
      return paneKey
    }
  }
  return oldestFallback
}

function isStaleStatus(entry: AgentHookEventPayload, now: number): boolean {
  const receivedAt = (entry as AgentHookEventPayload & { receivedAt?: unknown }).receivedAt
  return (
    typeof receivedAt === 'number' &&
    Number.isFinite(receivedAt) &&
    now - receivedAt > AGENT_STATUS_STALE_AFTER_MS
  )
}
