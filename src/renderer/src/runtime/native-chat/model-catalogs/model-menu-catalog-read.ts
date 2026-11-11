import type { AgentSessionModelCatalogResult } from '../../../../../shared/agent-session/agent-session-wire'
import type { RuntimeClientTarget } from '../../../../../shared/runtime-client-target'
import { callStructuredAgentSession } from '../requests/structured-agent-session-call'
import { modelMenuRequestContext, subscribeModelMenuInvalidation } from './model-menu-invalidation'

export type ModelMenuReadScope = {
  target: RuntimeClientTarget
  agent: string
  worktree?: string
}
type Request = {
  live: boolean
  claims: Set<{ signal: AbortSignal }>
  completion: Promise<AgentSessionModelCatalogResult>
}
const pending = new Map<string, Request>()

/** Shares only identical outstanding transport, never completed rows or opposite phases. */
export async function readModelMenuCatalog(
  scope: ModelMenuReadScope,
  waited: boolean,
  signal: AbortSignal
) {
  if (signal.aborted) {
    return undefined
  }
  const key = JSON.stringify([
    scope.target,
    scope.agent,
    scope.worktree,
    modelMenuRequestContext(scope.target),
    waited
  ])
  let request = pending.get(key)
  if (!request) {
    const record: Request = {
      live: true,
      claims: new Set(),
      completion: Promise.resolve()
        .then(() => {
          const beforeSend = () => {
            if (!record.live || ![...record.claims].some((claim) => !claim.signal.aborted)) {
              throw new Error('Model catalog request withdrawn')
            }
          }
          beforeSend()
          return callStructuredAgentSession<AgentSessionModelCatalogResult>(
            scope.target,
            'agentSession.modelCatalog',
            {
              agent: scope.agent,
              ...(scope.worktree ? { worktree: scope.worktree } : {}),
              ...(waited ? { waitForListing: true } : {})
            },
            { beforeSend }
          )
        })
        .finally(() => {
          stop()
          if (pending.get(key) === record) {
            pending.delete(key)
          }
        })
    }
    request = record
    pending.set(key, record)
    const stop = subscribeModelMenuInvalidation(scope.target, () => {
      record.live = false
      if (pending.get(key) === record) {
        pending.delete(key)
      }
    })
  }
  const current = request
  const claim = { signal }
  current.claims.add(claim)
  const withdraw = () => {
    current.claims.delete(claim)
    if (!current.claims.size) {
      current.live = false
      if (pending.get(key) === current) {
        pending.delete(key)
      }
    }
  }
  signal.addEventListener('abort', withdraw, { once: true })
  try {
    const answer = await current.completion
    return current.live && !signal.aborted ? answer : undefined
  } catch (error) {
    if (current.live && !signal.aborted) {
      throw error
    }
    return undefined
  } finally {
    signal.removeEventListener('abort', withdraw)
    withdraw()
  }
}
