import {
  STRUCTURED_LAUNCH_OPTION_IDS,
  STRUCTURED_LAUNCH_SEED_OPTION_IDS
} from './native-chat/input/native-chat-session-option-defaults'
import { decodeStructuredAgentSessionOptionValue } from './structured-agent-session-option-codec'
import type { NativeChatSessionOptionSettingsMutation } from './native-chat/input/native-chat-session-options'
import type { AgentSessionWriteFailure } from './agent-session-write-failure'

export type SelectionOutcome =
  | { kind: 'accepted'; options: Readonly<Record<string, string>> }
  | { kind: 'refused'; failure?: AgentSessionWriteFailure }
  | { kind: 'superseded' }
  | { kind: 'unknown'; failure?: AgentSessionWriteFailure }

const OPTION_ORDER: readonly string[] = STRUCTURED_LAUNCH_OPTION_IDS

type RememberedPicks = Extract<
  NativeChatSessionOptionSettingsMutation,
  { type: 'apply-picks' }
>['picks']
export type SelectionOperation = {
  identity: number
  key: string
  value: string
  model: string | null
  transmitted: boolean
  outcome?: SelectionOutcome
  request?: Promise<SelectionOutcome>
  result: Promise<SelectionOutcome>
  resolve: (outcome: SelectionOutcome) => void
  previousPending?: SelectionOperation
  nextPending?: SelectionOperation
}

/** Finite operation precedence above a queried host answer; no mutation reply installs a base. */
export function createStructuredSessionSelectionController(
  remember: (picks: RememberedPicks) => void,
  isCurrent: () => boolean = () => true
) {
  let sequence = 0
  let revision = 0
  let adopted = 0
  const inFlight = new Set<Promise<SelectionOutcome>>()
  const operations = new Map<number, SelectionOperation>()
  const latest = new Map<string, number>()
  const remembered = new Map<string, number>()
  const terminal = new Set<number>()
  let terminalRevision = 0
  const pendingCounts = new Map<string, number>()
  let pendingTail: SelectionOperation | undefined
  const currentOperations = () => [...latest.values()].flatMap((id) => operations.get(id) ?? [])
  const listeners = new Set<() => void>()
  const notify = () => {
    revision += 1
    for (const listener of listeners) {
      listener()
    }
  }
  const settle = (operation: SelectionOperation, outcome: SelectionOutcome): void => {
    if (operation.outcome) {
      return
    }
    if (!isCurrent()) {
      outcome = { kind: 'superseded' }
    }
    operation.outcome = outcome
    pendingCounts.set(operation.key, (pendingCounts.get(operation.key) ?? 1) - 1)
    if (operation.previousPending) {
      operation.previousPending.nextPending = operation.nextPending
    }
    if (operation.nextPending) {
      operation.nextPending.previousPending = operation.previousPending
    } else {
      pendingTail = operation.previousPending
    }
    operation.previousPending = undefined
    operation.nextPending = undefined
    operation.resolve(outcome)
    if (outcome.kind === 'accepted' || outcome.kind === 'unknown') {
      terminal.add(operation.identity)
      terminalRevision = revision + 1
    }
    if (outcome.kind === 'accepted') {
      const model =
        operation.key === 'model' ? (outcome.options.model ?? operation.model) : operation.model
      const value = decodeStructuredAgentSessionOptionValue(
        operation.key,
        outcome.options[operation.key] ?? operation.value
      )
      const key = operation.key === 'model' ? 'model' : JSON.stringify([model, operation.key])
      if (
        model &&
        value !== null &&
        STRUCTURED_LAUNCH_SEED_OPTION_IDS.some((id) => id === operation.key) &&
        (remembered.get(key) ?? 0) < operation.identity
      ) {
        remembered.set(key, operation.identity)
        const adopt = adopted <= operation.identity
        adopted = Math.max(adopted, operation.identity)
        try {
          remember([
            {
              modelId: model,
              optionId: operation.key,
              value,
              ...(!adopt ? { adoptModelAsLaunchDefault: false } : {})
            }
          ])
        } catch {
          /* Remembering never gates selection. */
        }
      }
    } else if (outcome.kind !== 'unknown') {
      operations.delete(operation.identity)
    }
    notify()
  }
  const transmit = (
    operation: SelectionOperation,
    send: (operation: SelectionOperation) => Promise<SelectionOutcome>
  ): Promise<SelectionOutcome> => {
    if (!isCurrent() || operation.outcome || operation.transmitted) {
      return operation.request ?? operation.result
    }
    operation.transmitted = true
    inFlight.add(operation.result)
    void operation.result.then(() => inFlight.delete(operation.result))
    const request = (async () => send(operation))()
    operation.request = request
    void request.then(
      (outcome) => settle(operation, outcome),
      () => settle(operation, { kind: 'unknown' })
    )
    notify()
    return request
  }
  return {
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    snapshot: () => revision,
    issue(
      key: string,
      value: string,
      model: string | null,
      offers?: (key: string, value: string) => boolean
    ): SelectionOperation {
      if (!isCurrent()) {
        const outcome = { kind: 'superseded' } as const
        return {
          identity: 0,
          key,
          value,
          model,
          transmitted: false,
          outcome,
          result: Promise.resolve(outcome),
          resolve: () => {}
        }
      }
      for (const previous of currentOperations()) {
        if (
          !previous.transmitted &&
          !previous.outcome &&
          (previous.key === key ||
            (key === 'model' && offers && !offers(previous.key, previous.value)))
        ) {
          settle(previous, { kind: 'superseded' })
        }
      }
      const reply = Promise.withResolvers<SelectionOutcome>()
      const operation: SelectionOperation = {
        identity: ++sequence,
        key,
        value,
        model: key === 'model' ? value : model,
        transmitted: false,
        result: reply.promise,
        resolve: reply.resolve
      }
      operation.previousPending = pendingTail
      if (pendingTail) {
        pendingTail.nextPending = operation
      }
      pendingTail = operation
      pendingCounts.set(key, (pendingCounts.get(key) ?? 0) + 1)
      operations.set(operation.identity, operation)
      latest.set(key, operation.identity)
      notify()
      return operation
    },
    overlay(): Record<string, string> {
      return Object.fromEntries(
        currentOperations().map((op) => [
          op.key,
          op.outcome?.kind === 'accepted' ? (op.outcome.options[op.key] ?? op.value) : op.value
        ])
      )
    },
    current: (key: string) => operations.get(latest.get(key) ?? -1),
    transmit,
    pending(): SelectionOperation[] {
      return [...operations.values()].filter((op) => !op.outcome)
    },
    isPending: (key: string) => (pendingCounts.get(key) ?? 0) > 0,
    pendingId: () => pendingTail?.key ?? null,
    freeze(replaced: readonly SelectionOperation[] = []): SelectionOperation[] {
      if (!isCurrent()) {
        return []
      }
      // A definitive create refusal permits a new capture; an ambiguous retry never calls freeze.
      for (const op of replaced) {
        if (!op.outcome && operations.get(op.identity) === op) {
          if (latest.get(op.key) === op.identity) {
            op.transmitted = false
          } else {
            settle(op, { kind: 'superseded' })
          }
        }
      }
      const frozen = currentOperations().filter((op) => !op.transmitted && !op.outcome)
      for (const op of frozen) {
        op.transmitted = true
      }
      return frozen
    },
    settle,
    terminalSnapshot: () => (terminal.size ? terminalRevision : 0),
    captureRead(): number[] {
      return [...terminal]
    },
    retire(identities: readonly number[]): void {
      for (const identity of identities) {
        operations.delete(identity)
        terminal.delete(identity)
      }
      if (identities.length) {
        terminalRevision = revision + 1
        notify()
      }
    },
    flush(send: (operation: SelectionOperation) => Promise<SelectionOutcome>): void {
      if (!isCurrent()) {
        return
      }
      const unsent = currentOperations().filter((op) => !op.transmitted && !op.outcome)
      unsent.sort((a, b) => OPTION_ORDER.indexOf(a.key) - OPTION_ORDER.indexOf(b.key))
      for (const operation of unsent) {
        void transmit(operation, send)
      }
    },
    async drain(): Promise<void> {
      while (inFlight.size) {
        await Promise.all(inFlight)
      }
    },
    abandon(): void {
      for (const operation of operations.values()) {
        settle(operation, { kind: 'superseded' })
      }
      operations.clear()
      latest.clear()
      remembered.clear()
      terminal.clear()
      pendingCounts.clear()
      notify()
    }
  }
}
export type StructuredSessionSelectionController = ReturnType<
  typeof createStructuredSessionSelectionController
>
