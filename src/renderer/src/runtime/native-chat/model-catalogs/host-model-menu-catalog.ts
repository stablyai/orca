import type { AgentSessionModelCatalogResult } from '../../../../../shared/agent-session/agent-session-wire'
import { HostModelMenuPhases } from './host-model-menu-phases'
import type { RuntimeClientTarget } from '../../../../../shared/runtime-client-target'
import { structuredAgentSessionHostKey } from '../host-capabilities/structured-agent-session-host-capability'
import { callStructuredAgentSession } from '../requests/structured-agent-session-call'
import {
  hostModelCatalogGeneration,
  readHostModelCatalogSnapshot,
  recordHostModelCatalogSnapshot,
  subscribeHostModelCatalogSnapshot
} from './host-model-catalog-snapshots'

export type HostModelMenuScope = {
  target: RuntimeClientTarget
  agent: string
  worktree?: string
}
export type HostModelMenuSnapshot = {
  answer?: AgentSessionModelCatalogResult
  pending: boolean
  attempted?: boolean
  generation: number
}
const owners = new Map<string, HostModelMenuCatalog>()
function withoutWaitExpiry(answer: AgentSessionModelCatalogResult) {
  if (!answer.waitExpired) {
    return answer
  }
  const { waitExpired: _waitExpired, ...catalog } = answer
  return catalog
}
function retained(answer: AgentSessionModelCatalogResult | undefined) {
  return answer?.listingInProgress && (answer.origin === 'unknown' || !answer.models.length)
    ? undefined
    : answer && withoutWaitExpiry(answer)
}

function withListingStatus(
  held: AgentSessionModelCatalogResult,
  answer: AgentSessionModelCatalogResult
): AgentSessionModelCatalogResult {
  return {
    ...withoutWaitExpiry(held),
    listingInProgress: true,
    ...(answer.waitExpired ? { waitExpired: true } : {})
  }
}

function keyOf(scope: HostModelMenuScope) {
  return JSON.stringify([structuredAgentSessionHostKey(scope.target), scope.agent, scope.worktree])
}

class HostModelMenuCatalog {
  listeners = new Set<() => void>()
  snapshot: HostModelMenuSnapshot
  private phases = new HostModelMenuPhases(
    (waited, current) => this.requestPhase(waited, current),
    () => ({
      ...withoutWaitExpiry(this.snapshot.answer ?? { origin: 'unknown' }),
      listingInProgress: true
    }),
    () => this.syncPhases()
  )
  private unsubscribe?: () => void
  constructor(readonly scope: HostModelMenuScope) {
    this.snapshot = {
      answer: this.held(),
      pending: false,
      generation: hostModelCatalogGeneration(scope.target, scope.agent)
    }
  }
  private held() {
    return readHostModelCatalogSnapshot(this.scope.target, this.scope.agent, {
      newLaunch: true,
      seedsModel: true,
      worktree: this.scope.worktree ?? null
    })
  }
  publish(value: Omit<HostModelMenuSnapshot, 'generation'>) {
    const next = {
      ...value,
      generation: hostModelCatalogGeneration(this.scope.target, this.scope.agent)
    }
    if (
      this.snapshot.generation === next.generation &&
      this.snapshot.pending === next.pending &&
      this.snapshot.attempted === next.attempted &&
      (this.snapshot.answer === next.answer ||
        JSON.stringify(this.snapshot.answer) === JSON.stringify(next.answer))
    ) {
      return
    }
    this.snapshot = next
    this.listeners.forEach((listener) => listener())
  }
  subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    this.watch()
    return () => {
      this.listeners.delete(listener)
      this.retire()
    }
  }
  private watch() {
    this.unsubscribe ??= subscribeHostModelCatalogSnapshot(
      this.scope.target,
      this.scope.agent,
      (change) => {
        if (change.forgotten) {
          this.phases.invalidate()
          this.syncPhases()
        } else {
          this.publish({ ...this.snapshot, answer: this.held() })
        }
      }
    )
  }
  private syncPhases() {
    const generation = hostModelCatalogGeneration(this.scope.target, this.scope.agent)
    this.publish({
      ...(this.snapshot.generation === generation ? this.snapshot : {}),
      pending: this.phases.pending
    })
    this.retire()
  }
  read(waitForListing: boolean | undefined, signal: AbortSignal) {
    if (signal.aborted) {
      return Promise.resolve(undefined)
    }
    this.watch()
    return this.phases.read(waitForListing, signal)
  }
  private async requestPhase(waitForListing: boolean, current: () => boolean) {
    const { target, agent, worktree } = this.scope
    let answer: AgentSessionModelCatalogResult | undefined
    try {
      answer = await callStructuredAgentSession(target, 'agentSession.modelCatalog', {
        agent,
        ...(worktree ? { worktree } : {}),
        ...(waitForListing ? { waitForListing: true } : {})
      })
    } catch {}
    if (!current()) {
      return {}
    }
    if (answer) {
      recordHostModelCatalogSnapshot(target, agent, worktree ?? null, withoutWaitExpiry(answer))
    }
    const shown = answer?.listingInProgress
      ? withListingStatus(this.held() ?? answer, {
          ...answer,
          waitExpired: waitForListing && answer.waitExpired ? true : undefined
        })
      : answer
        ? this.held()
        : retained(this.held() ?? this.snapshot.answer)
    this.publish({ answer: shown, pending: this.phases.pending, attempted: true })
    return { answer: shown, reply: answer, waited: waitForListing }
  }
  private retire() {
    if (!this.listeners.size && !this.phases.busy) {
      this.unsubscribe?.()
      this.unsubscribe = undefined
      if (owners.get(keyOf(this.scope)) === this) {
        owners.delete(keyOf(this.scope))
      }
    }
  }
}

export function hostModelMenuCatalog(scope: HostModelMenuScope) {
  const key = keyOf(scope)
  let owner = owners.get(key)
  if (!owner) {
    owner = new HostModelMenuCatalog(scope)
    owners.set(key, owner)
  }
  return owner
}
