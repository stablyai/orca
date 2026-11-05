import type { AgentSessionOptionCatalog } from './agent-session-option-catalog-types'
import type { AgentSessionModelCatalogResult } from '../agent-session-wire'
import type { AgentSessionOptionsResult } from './agent-session-options-result'
import { createCoalescingKeyedRunner } from '../../coalescing-keyed-runner'
import { structuralValuesEqualIgnoringUndefined } from '../../structural-value-equality'
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
    owner: readonly unknown[]
    sessionId: string | null
    fence: number | null
  } | null
}
const same = (left: readonly unknown[], right: readonly unknown[]) =>
  left.length === right.length && left.every((value, index) => Object.is(value, right[index]))
// Answers fill the record in place, so comparing starts before applying; JSON skips the catalog's fresh closures.
const applyKeepingIdentity = (
  current: StructuredAgentSessionOptionState,
  apply: (current: StructuredAgentSessionOptionState) => StructuredAgentSessionOptionState
) => {
  const before = JSON.stringify(current)
  const next = apply(current)
  return JSON.stringify(next) === before ? current : next
}

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
  let retries = 0
  let retryTimer: ReturnType<typeof setTimeout> | undefined
  const cancelRetry = () => {
    clearTimeout(retryTimer)
    retryTimer = undefined
  }
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
      const isCurrentRead = () =>
        lease === attached &&
        version === capturedVersion &&
        snapshot.optionState.record === record &&
        attached.isCurrent() &&
        Object.is(attached.authority(), authority)
      let result: AgentSessionOptionsResult
      try {
        result = await attached.request()
      } catch {
        const support = snapshot.support
        if (
          isCurrentRead() &&
          support &&
          same(support.owner, attached.owner) &&
          support.result.canSwitchAccount === true
        ) {
          snapshot = {
            ...snapshot,
            support: { ...support, result: { ...support.result, canSwitchAccount: false } }
          }
          notify()
        }
        if (isCurrentRead() && !dirty && retries < 2) {
          retries++
          retryTimer = setTimeout(() => {
            retryTimer = undefined
            if (!isCurrentRead()) {
              return
            }
            dirty = true
            schedule()
          }, 250)
        }
        return
      }
      if (!isCurrentRead()) {
        return
      }
      retries = 0
      cancelRetry()
      const before = snapshot
      const { optionCatalog } = attached
      const optionState = optionCatalog
        ? applyKeepingIdentity(before.optionState, (current) =>
            applyStructuredAgentSessionOptions(current, optionCatalog, result, attached)
          )
        : before.optionState
      const support =
        before.support &&
        same(before.support.owner, attached.owner) &&
        before.support.fence === attached.fence &&
        structuralValuesEqualIgnoringUndefined(before.support.result, result)
          ? before.support
          : { result, owner: attached.owner, sessionId: attached.sessionId, fence: attached.fence }
      if (optionState !== before.optionState || support !== before.support) {
        snapshot = { optionState, support }
      }
      attached.accepted?.()
      attached.controller.retire(completed)
      if (snapshot !== before) {
        notify()
      }
    }).catch(() => undefined)
  }
  const invalidate = () => {
    cancelRetry()
    retries = 0
    version++
    dirty = true
    schedule()
  }
  return {
    getSnapshot: () => snapshot,
    supportFor: (owner: readonly unknown[]) =>
      snapshot.support && same(snapshot.support.owner, owner) ? snapshot.support : null,
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
    /** Its view moved to another chat: the answer stays to show on return, but the process may restart
     * and the options move meanwhile, so its reports and accepted inputs wait for the next answer. */
    markAway() {
      const current = snapshot.optionState
      snapshot = {
        ...snapshot,
        optionState: {
          ...current,
          record: cloneStructuredAgentSessionOptionRecord(current.record),
          reportedPermissionMode: undefined,
          reportedModel: undefined,
          reportedEffort: undefined,
          ...(current.acceptedInputSources ? { acceptedInputSources: {} } : {})
        }
      }
    },
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
                reportedModel: undefined,
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
          cancelRetry()
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
      updateOptionState((state) =>
        applyKeepingIdentity(state, (current) =>
          catalog && context.optionCatalog
            ? applyStructuredAgentSessionModelCatalog(
                current,
                context.optionCatalog,
                catalog,
                context
              )
            : settleStructuredAgentSessionBuiltinCatalog(current, false)
        )
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
