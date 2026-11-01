import type { AgentSessionOptionCatalog } from './agent-session-option-catalog'
import type {
  AgentSessionModelCatalogResult,
  AgentSessionOptionsResult
} from './agent-session-wire'
import { createCoalescingKeyedRunner } from './coalescing-keyed-runner'
import { cloneStructuredAgentSessionOptionRecord } from './structured-agent-session-option-state'
import {
  applyStructuredAgentSessionModelCatalog,
  applyStructuredAgentSessionOptions,
  settleStructuredAgentSessionBuiltinCatalog,
  type StructuredAgentSessionOptionState
} from './structured-agent-session-options'
import type { StructuredSessionSelectionController } from './structured-agent-session-selection-operations'

type ReadContext = {
  owner: readonly unknown[]
  reset: readonly unknown[]
  sessionId: string | null
  fence: number | null
  seed: () => StructuredAgentSessionOptionState
  controller: StructuredSessionSelectionController
  eligible: boolean
  optionCatalog: AgentSessionOptionCatalog | null
  newLaunch: boolean
  coherentCatalog: boolean
  authority: () => unknown
  isCurrent: () => boolean
  request: () => Promise<AgentSessionOptionsResult>
  accepted?: () => void
}

type ReadSnapshot = {
  optionState: StructuredAgentSessionOptionState
  support: {
    result: AgentSessionOptionsResult
    sessionId: string | null
    fence: number | null
  } | null
}
const same = (left: readonly unknown[], right: readonly unknown[]) =>
  left.length === right.length && left.every((value, index) => Object.is(value, right[index]))

/** One live scope owns capture, accepted publication and causal retirement on either surface. */
export function createStructuredAgentSessionOptionsReadOwner(
  seed: StructuredAgentSessionOptionState
) {
  let snapshot: ReadSnapshot = { optionState: seed, support: null }
  let previous: ReadContext | undefined
  let lease: (ReadContext & { key: string }) | undefined
  let leases = 0
  let version = 0
  let dirty = true
  const listeners = new Set<() => void>()
  const notify = () => listeners.forEach((listener) => listener())
  const run = createCoalescingKeyedRunner<void>()
  const updateOptionState = (
    update: (current: StructuredAgentSessionOptionState) => StructuredAgentSessionOptionState
  ) => {
    const optionState = update(snapshot.optionState)
    if (optionState !== snapshot.optionState) {
      snapshot = { ...snapshot, optionState }
      notify()
    }
  }
  const schedule = () => {
    const attached = lease
    if (!attached?.eligible) {
      return
    }
    // Coalesce within a lease; a new lease reads at once and the old lease's reply stays inert.
    void run(attached.key, 'latest', async () => {
      if (lease !== attached || !dirty || !attached.isCurrent()) {
        return
      }
      dirty = false
      const capturedVersion = version
      const record = snapshot.optionState.record
      const authority = attached.authority()
      const completed = attached.controller.captureRead()
      const result = await attached.request()
      if (
        lease !== attached ||
        version !== capturedVersion ||
        snapshot.optionState.record !== record ||
        !attached.isCurrent() ||
        !Object.is(attached.authority(), authority)
      ) {
        return
      }
      snapshot = {
        optionState: attached.optionCatalog
          ? applyStructuredAgentSessionOptions(
              snapshot.optionState,
              attached.optionCatalog,
              result,
              attached
            )
          : snapshot.optionState,
        support: { result, sessionId: attached.sessionId, fence: attached.fence }
      }
      attached.accepted?.()
      attached.controller.retire(completed)
      notify()
    }).catch(() => undefined)
  }
  const invalidate = () => {
    version++
    dirty = true
    schedule()
  }
  return {
    getSnapshot: () => snapshot,
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    optionStateRef: {
      get current() {
        return snapshot.optionState
      }
    },
    activeOptionRecordRef: {
      get current() {
        return snapshot.optionState.record
      }
    },
    updateOptionState,
    invalidate,
    attach(context: ReadContext) {
      const sameOwner = !previous || same(previous.owner, context.owner)
      if (!previous || !sameOwner || !same(previous.reset, context.reset)) {
        const current = snapshot.optionState
        const kept =
          sameOwner &&
          (current.optionsAnswerPresent ||
            (current.catalogSource !== 'seed' && current.catalogSource !== null))
            ? {
                ...current,
                record: cloneStructuredAgentSessionOptionRecord(current.record),
                reportedPermissionMode: undefined,
                reportedEffort: undefined
              }
            : context.seed()
        // Support stays tagged with its session; consumers filter by session, so it bridges a re-pair.
        snapshot = {
          ...snapshot,
          optionState: sameOwner ? { ...kept, permissionMode: current.permissionMode } : kept
        }
        notify()
      }
      previous = context
      const attached = { ...context, key: String(++leases) }
      lease = attached
      invalidate()
      return () => {
        if (lease === attached) {
          lease = undefined
          version++
          dirty = true
        }
      }
    },
    receiveCatalog(
      catalog: AgentSessionModelCatalogResult | null,
      _event: 'demand' | 'progress' | 'settled'
    ) {
      const context = lease
      if (!context) {
        return
      }
      updateOptionState((current) =>
        catalog && context.optionCatalog
          ? applyStructuredAgentSessionModelCatalog(
              current,
              context.optionCatalog,
              catalog,
              context
            )
          : settleStructuredAgentSessionBuiltinCatalog(current, false)
      )
      if (
        !context.coherentCatalog &&
        catalog &&
        catalog.origin !== 'unknown' &&
        !catalog.listingInProgress
      ) {
        invalidate()
      }
    }
  }
}
