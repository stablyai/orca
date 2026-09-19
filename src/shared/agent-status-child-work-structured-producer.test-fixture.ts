import type { AgentSessionBackgroundTaskState } from './agent-session-background-task-wire'
import { createAgentChildWorkAdmission } from './agent-status-child-work-admission'
import {
  reconcileStructuredChildWork,
  type StructuredChildWorkReconcileOutcome
} from './agent-status-child-work-reconciliation'
import { decodeStructuredChildWorkEvidence } from './agent-status-child-work-structured-evidence'
import {
  projectStructuredChildWorkBackgroundTaskState,
  projectStructuredChildWorkSubagents,
  STRUCTURED_SUPPORTS_STOP_ALL_FACT,
  STRUCTURED_SUPPORTS_TASK_STOP_FACT
} from './agent-status-child-work-structured-egress'
import { createAgentStatusStore, type AgentStatusStore } from './agent-status-store'
import {
  makeStructuredAgentStatusSubject,
  type AgentStatusExecutionScope,
  type AgentStatusStructuredSessionSubject
} from './agent-status-subject'

export const FIXTURE_SESSION_ID = 'session_11111111-1111-4111-8111-111111111111'

export const FIXTURE_SCOPE: AgentStatusExecutionScope = {
  executionHostId: 'local',
  wslDistro: null,
  workspaceId: 'workspace-1',
  workspaceKind: 'git-worktree'
}

export function fixtureSubject(
  overrides: Partial<AgentStatusExecutionScope> = {},
  sessionId = FIXTURE_SESSION_ID
): AgentStatusStructuredSessionSubject {
  return makeStructuredAgentStatusSubject({ ...FIXTURE_SCOPE, ...overrides }, sessionId)
}

export type StructuredChildWorkProducerFixture = ReturnType<
  typeof createStructuredChildWorkProducerFixture
>

/**
 * The real producer over a real authority store: decoder, reconciler and admission API,
 * with only the id mint and the clock made deterministic. Tests that skip this and hand
 * the store hand-written child rows prove nothing about the producer.
 */
export function createStructuredChildWorkProducerFixture(options?: {
  store?: AgentStatusStore
  parent?: AgentStatusStructuredSessionSubject
  provider?: string
  withParent?: boolean
  /** Distinguish mints when two fixtures share one store, as two hosts would. */
  idPrefix?: string
}) {
  const parent = options?.parent ?? fixtureSubject()
  const provider = options?.provider ?? 'claude'
  const store = options?.store ?? createAgentStatusStore({ epoch: 'epoch-a', mode: 'authority' })
  let minted = 0
  const admission = createAgentChildWorkAdmission(store, {
    mintChildWorkId: () => `${options?.idPrefix ?? 'child'}-${++minted}`
  })
  if (options?.withParent !== false) {
    store.applyMutation({ parent: { subject: parent } })
  }
  let clock = 1_000

  return {
    store,
    parent,
    provider,
    get mintedCount() {
      return minted
    },
    now: () => clock,
    /** Admit one full adapter roster. `null` is the provider's authoritative empty. */
    publish(
      state: AgentSessionBackgroundTaskState | null,
      at?: number
    ): StructuredChildWorkReconcileOutcome {
      clock = at ?? clock + 1
      const evidence = decodeStructuredChildWorkEvidence(state)
      store.applyMutation({
        facts: [
          {
            subject: parent,
            key: STRUCTURED_SUPPORTS_TASK_STOP_FACT,
            value: evidence.supportsTaskStop
          },
          {
            subject: parent,
            key: STRUCTURED_SUPPORTS_STOP_ALL_FACT,
            value: evidence.supportsStopAll
          }
        ]
      })
      return reconcileStructuredChildWork({
        store,
        admission,
        parent,
        provider,
        evidence,
        observedAt: clock
      })
    },
    children: () => store.getChildren(parent),
    childFor(providerTaskId: string) {
      return (
        store
          .getChildren(parent)
          .find((child) =>
            store
              .getAliasesForChild(child.childWorkId)
              .some((alias) => alias.alias === providerTaskId)
          ) ?? null
      )
    },
    subagents: () => projectStructuredChildWorkSubagents(store, parent),
    backgroundTaskState: () => projectStructuredChildWorkBackgroundTaskState(store, parent)
  }
}
