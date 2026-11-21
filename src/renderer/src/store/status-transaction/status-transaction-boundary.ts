import type { StateCreator } from 'zustand'
import type { AppState } from '../types'
import type { StoreSetArgs } from '../diagnostics/react-commit-cascade-write-probe'
import type { AcceptedAgentStatuses } from '../slices/agent-status/status-ownership/accepted-agent-statuses'
import { createAgentStatusTransactionOwner } from '../slices/agent-status/status-ownership/agent-status-transaction-owner'
import { stageHostStatusDraft } from '../slices/runtime-status/host-status-transaction-draft'
import { createStatusTransaction, swapOpenStatusTransaction } from './status-transaction'

/**
 * Outermost policy: finish transformations and getters, then per write stage each status owner's
 * draft, commit the drafts before the root write, and notify owners after it.
 */
export function withStatusTransaction(
  createState: StateCreator<AppState, [], []>
): StateCreator<AppState, [], []> {
  return (set, get, api) => {
    const subscribe = api.subscribe
    api.subscribe = (listener) =>
      subscribe((...args) => {
        try {
          listener(...args)
        } catch (error) {
          console.error('Store observer failed', error)
        }
      })
    const transaction = createStatusTransaction()
    const agentStatuses = createAgentStatusTransactionOwner()
    const wrap =
      (write: typeof set): typeof set =>
      (...args: StoreSetArgs<AppState>): void => {
        const current = get()
        // An updater may write this store re-entrantly; each write keeps its own staged drafts.
        const outerOpen = swapOpenStatusTransaction(transaction)
        const outerBase = transaction.base
        const outerHostStatuses = transaction.hostStatuses
        transaction.base = current
        transaction.hostStatuses = undefined
        let next: AppState
        let agentDraft: AcceptedAgentStatuses
        try {
          let requested: AppState | Partial<AppState>
          try {
            requested = typeof args[0] === 'function' ? args[0](current) : args[0]
          } finally {
            transaction.base = outerBase
            swapOpenStatusTransaction(outerOpen)
          }
          if (requested === current && transaction.hostStatuses === undefined) {
            return
          }
          // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Zustand's replace overload requires a complete state; merged writes inherit all other fields.
          next = { ...(args[1] === true ? {} : get()), ...requested } as AppState
          // Host statuses stage first: agent projection preparation reads the composed root write.
          stageHostStatusDraft(transaction, current, next)
          agentDraft = agentStatuses.stage(current, next)
        } finally {
          transaction.hostStatuses = outerHostStatuses
        }
        agentStatuses.commit()
        write(next, true)
        // Host status listeners wake from the root write itself.
        agentStatuses.notify(agentDraft)
      }
    api.setState = wrap(api.setState)
    const state = createState(wrap(set), get, api)
    const initial = agentStatuses.initialize(state)
    api.getInitialState = () => initial
    return state
  }
}
