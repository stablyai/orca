import type { AgentSessionModelCatalogResult } from '../../../../../shared/agent-session/agent-session-wire'
import type { RuntimeClientTarget } from '../../../../../shared/runtime-client-target'
import { structuredAgentSessionHostKey } from '../host-capabilities/structured-agent-session-host-capability'
import { callStructuredAgentSession } from '../requests/structured-agent-session-call'
import {
  hostModelCatalogGeneration,
  readHostModelCatalogSnapshot,
  recordHostModelCatalogSnapshot,
  subscribeHostModelCatalogSnapshot
} from './host-model-catalog-snapshots'

export type HostModelMenuScope = { target: RuntimeClientTarget; agent: string; worktree?: string }
export type HostModelMenuSnapshot = {
  answer?: AgentSessionModelCatalogResult
  pending: boolean
  attempted?: boolean
  generation: number
}
type Reader = (waitForListing: boolean) => Promise<AgentSessionModelCatalogResult | undefined>
const owners = new Map<string, HostModelMenuCatalog>()

function keyOf(scope: HostModelMenuScope) {
  return JSON.stringify([structuredAgentSessionHostKey(scope.target), scope.agent, scope.worktree])
}

class HostModelMenuCatalog {
  listeners = new Set<() => void>()
  snapshot: HostModelMenuSnapshot
  private pending?: Promise<AgentSessionModelCatalogResult | undefined>
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
      worktree: this.scope.worktree
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
    this.unsubscribe ??= subscribeHostModelCatalogSnapshot(
      this.scope.target,
      this.scope.agent,
      (change) => {
        if (change.forgotten) {
          // An older account's physical read may finish, but cannot own this generation.
          this.pending = undefined
          this.publish({ pending: false })
        } else {
          const exact = change.worktree === (this.scope.worktree ?? null)
          const current = this.snapshot.answer
          if (
            !exact &&
            change.worktree !== null &&
            current &&
            !current.listingInProgress &&
            (current.origin === 'unknown' || current.models.length === 0)
          ) {
            return
          }
          const held = this.held()
          const retired =
            !change.catalog.listingInProgress &&
            (change.catalog.origin === 'unknown' || change.catalog.models.length === 0)
          this.publish({
            ...this.snapshot,
            answer: exact && retired ? change.catalog : held
          })
        }
      }
    )
    return () => {
      this.listeners.delete(listener)
      this.retire()
    }
  }
  read(): Promise<AgentSessionModelCatalogResult | undefined> {
    if (this.pending) {
      return this.pending
    }
    const { target, agent, worktree } = this.scope
    const generation = hostModelCatalogGeneration(target, agent)
    const current = () => generation === hostModelCatalogGeneration(target, agent)
    const request: Reader = (waitForListing) =>
      callStructuredAgentSession(target, 'agentSession.modelCatalog', {
        agent,
        ...(worktree ? { worktree } : {}),
        ...(waitForListing ? { waitForListing: true } : {})
      })
    this.publish({ ...this.snapshot, pending: true })
    const operation: Promise<AgentSessionModelCatalogResult | undefined> = Promise.resolve()
      .then(() => request(false))
      .then(async (plain) => {
        if (!current()) {
          return this.pending !== operation ? this.pending : undefined
        }
        if (plain?.listingInProgress) {
          this.publish({ answer: plain, pending: true })
          return request(true)
        }
        return plain
      })
      .catch(() => undefined)
      .then((answer) => {
        if (!current()) {
          return this.pending !== operation ? this.pending : undefined
        }
        this.publish({ answer, pending: false, attempted: true })
        if (answer) {
          recordHostModelCatalogSnapshot(target, agent, worktree ?? null, answer)
        }
        return answer
      })
      .finally(() => {
        if (this.pending === operation) {
          this.pending = undefined
        }
        this.retire()
      })
    this.pending = operation
    return operation
  }
  private retire() {
    if (!this.listeners.size && !this.pending) {
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
