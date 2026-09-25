import {
  serializeAgentChildWorkAliasKey,
  type AgentChildWorkAliasInput,
  type AgentChildWorkAliasRecord
} from './agent-status-child-work-alias'
import {
  AGENT_CHILD_WORK_DESCRIPTION_MAX_LENGTH,
  AGENT_CHILD_WORK_LABEL_MAX_LENGTH,
  AGENT_CHILD_WORK_LAST_MESSAGE_MAX_LENGTH,
  agentChildWorkFencesEqual,
  type AgentChildWorkId,
  type AgentChildWorkInput,
  type AgentChildWorkInvocationFence,
  type AgentChildWorkKind,
  type AgentChildWorkOperation,
  type AgentChildWorkRecord
} from './agent-status-child-work'
import {
  isAgentChildWorkOperationBasis,
  isAgentChildWorkOwner,
  isAgentChildWorkResidency
} from './agent-status-child-work-activity-codec'
import {
  parseAgentChildWorkInput,
  parseAgentChildWorkProviderTiming
} from './agent-status-child-work-codec'
import {
  isChildWorkTokenCount,
  normalizeChildWorkText
} from './agent-status-child-work-value-guards'
import { agentChildWorkAllowsOperation } from './agent-status-child-work-legality'
import {
  AGENT_STATUS_TOOL_INPUT_MAX_LENGTH,
  AGENT_STATUS_TOOL_NAME_MAX_LENGTH
} from './agent-status-types'
import type {
  AgentChildWorkAdmissionResult,
  AgentChildWorkAdoptRequest,
  AgentChildWorkAnnounceRequest,
  AgentChildWorkObservationAlias,
  AgentChildWorkObservationFields
} from './agent-status-child-work-admission'
import type { AgentStatusStore } from './agent-status-store'
import { agentStatusSubjectsEqual, type AgentStatusSubject } from './agent-status-subject'

const MAX_ALIASES_PER_ADMISSION = 32

export function rejectAgentChildWorkAdmission(
  reason: Extract<AgentChildWorkAdmissionResult, { accepted: false }>['reason']
) {
  return { accepted: false, reason } as const
}

export function findAgentChildWork(
  store: AgentStatusStore,
  childWorkId: string
): AgentChildWorkRecord | null {
  return store.getChild(childWorkId)
}

export function agentChildWorkAliasesForChild(
  store: AgentStatusStore,
  childWorkId: string
): AgentChildWorkAliasRecord[] {
  return store.getAliasesForChild(childWorkId)
}

export function buildAgentChildWorkAliases(
  parent: AgentStatusSubject,
  provider: string,
  kind: AgentChildWorkKind,
  aliases: AgentChildWorkObservationAlias[],
  childWorkId: AgentChildWorkId,
  fence: AgentChildWorkInvocationFence
): AgentChildWorkAliasInput[] | null {
  if (aliases.length === 0 || aliases.length > MAX_ALIASES_PER_ADMISSION) {
    return null
  }
  const built: AgentChildWorkAliasInput[] = []
  const keys = new Set<string>()
  try {
    for (const alias of aliases) {
      const candidate = { parent, provider, kind, ...alias, childWorkId, fence }
      const key = serializeAgentChildWorkAliasKey(candidate)
      if (keys.has(key)) {
        return null
      }
      keys.add(key)
      built.push(candidate)
    }
  } catch {
    return null
  }
  return built
}

/** The fields only the host writes: identity, the invocation, and when it settled. */
export type AgentChildWorkHostFields = {
  childWorkId: AgentChildWorkId
  firstObservedAt: number
  invocation: AgentChildWorkInvocationFence
  previousInvocations?: AgentChildWorkInput['previousInvocations']
  settledAt?: number
}

/** Stamped once, when the current invocation first settles; later settled evidence keeps it. */
export function agentChildWorkSettledAt(
  request: Pick<AgentChildWorkObservationFields, 'membership' | 'observedAt'>,
  current?: Pick<AgentChildWorkRecord, 'membership' | 'settledAt'>
): number | undefined {
  if (request.membership !== 'settled') {
    return undefined
  }
  return current?.membership === 'settled' && current.settledAt !== undefined
    ? current.settledAt
    : request.observedAt
}

/** Request fields that describe the child, as opposed to its lifecycle, clock or provenance. */
type AgentChildWorkFactKey = Exclude<
  keyof AgentChildWorkObservationFields,
  'kind' | 'state' | 'membership' | 'observedAt' | 'stoppable' | 'provenance'
>

/** Every fact is listed, so a request field added without a parse and a merge rule fails to
 *  compile. `undefined` means the observation did not say it. */
type AgentChildWorkFacts = {
  [K in AgentChildWorkFactKey]-?: AgentChildWorkObservationFields[K] | undefined
}

function parseObservedOperation(
  request: AgentChildWorkObservationFields,
  firstObservedAt: number
): AgentChildWorkOperation | undefined {
  const operation = request.operation
  if (
    !operation ||
    !agentChildWorkAllowsOperation(request.membership, request.state) ||
    !isAgentChildWorkOperationBasis(operation.basis) ||
    !Number.isFinite(operation.observedAt)
  ) {
    return undefined
  }
  const toolName = normalizeChildWorkText(operation.toolName, AGENT_STATUS_TOOL_NAME_MAX_LENGTH)
  const input = normalizeChildWorkText(operation.input, AGENT_STATUS_TOOL_INPUT_MAX_LENGTH)
  return toolName
    ? {
        toolName,
        ...(input ? { input } : {}),
        basis: operation.basis,
        // A producer may stamp provider time; the host bounds it to the child's evidence window.
        observedAt: Math.min(Math.max(operation.observedAt, firstObservedAt), request.observedAt)
      }
    : undefined
}

/** Provider facts are untrusted: each becomes a value the record codec accepts, or "not said".
 *  A malformed fact is dropped here so it can neither reject the observation nor erase what
 *  the record already knows. */
function parseObservationFacts(
  request: AgentChildWorkObservationFields,
  host: Pick<AgentChildWorkHostFields, 'childWorkId' | 'firstObservedAt'>
): AgentChildWorkFacts {
  const timing =
    request.providerTiming === undefined
      ? null
      : parseAgentChildWorkProviderTiming(request.providerTiming)
  return {
    outcome: request.outcome,
    name: normalizeChildWorkText(request.name, AGENT_CHILD_WORK_LABEL_MAX_LENGTH),
    description: normalizeChildWorkText(
      request.description,
      AGENT_CHILD_WORK_DESCRIPTION_MAX_LENGTH
    ),
    agentType: normalizeChildWorkText(request.agentType, AGENT_CHILD_WORK_LABEL_MAX_LENGTH),
    model: normalizeChildWorkText(request.model, AGENT_CHILD_WORK_LABEL_MAX_LENGTH),
    totalTokens: isChildWorkTokenCount(request.totalTokens) ? request.totalTokens : undefined,
    providerTiming: timing ?? undefined,
    parentChildWorkId: isAgentChildWorkOwner(request.parentChildWorkId, host.childWorkId)
      ? request.parentChildWorkId
      : undefined,
    residency: isAgentChildWorkResidency(request.residency) ? request.residency : undefined,
    operation: parseObservedOperation(request, host.firstObservedAt),
    lastMessage: normalizeChildWorkText(
      request.lastMessage,
      AGENT_CHILD_WORK_LAST_MESSAGE_MAX_LENGTH
    )
  }
}

/** A sparse observation never erases what the record knows (a roster omission knows only "it is
 *  gone"). `run` is the stored record only when this observation continues its invocation. */
function mergeObservationFacts(
  said: AgentChildWorkFacts,
  prior: AgentChildWorkRecord | undefined,
  run: AgentChildWorkRecord | undefined
): AgentChildWorkFacts {
  return {
    // Refine-only: an `unknown` ending claims nothing, so a definite one stands.
    outcome:
      said.outcome === undefined || said.outcome === 'unknown'
        ? (run?.outcome ?? said.outcome)
        : said.outcome,
    name: said.name ?? prior?.name,
    description: said.description ?? prior?.description,
    agentType: said.agentType ?? prior?.agentType,
    model: said.model ?? prior?.model,
    residency: said.residency ?? prior?.residency,
    // Cumulative, so a late or duplicate frame never shrinks it.
    totalTokens:
      said.totalTokens !== undefined && prior?.totalTokens !== undefined
        ? Math.max(said.totalTokens, prior.totalTokens)
        : (said.totalTokens ?? prior?.totalTokens),
    // Whoever started this run owns it; a restart names its own spawner, or none for the main agent.
    parentChildWorkId: said.parentChildWorkId ?? run?.parentChildWorkId,
    lastMessage: said.lastMessage ?? run?.lastMessage,
    // The provider's start and end of this run: a restart has not completed.
    providerTiming: said.providerTiming ?? run?.providerTiming,
    // Its absence means the child stopped doing it.
    operation: said.operation
  }
}

/** Builds the record admission writes: parse the observation, merge it over `prior` (the stored
 *  record on update and resume), and let the codec check the invariants. */
export function buildAgentChildWork(
  request: AgentChildWorkObservationFields & {
    parent: AgentStatusSubject
    provider: string
  },
  host: AgentChildWorkHostFields,
  prior?: AgentChildWorkRecord
): AgentChildWorkInput | null {
  const run =
    prior && agentChildWorkFencesEqual(prior.invocation, host.invocation) ? prior : undefined
  return parseAgentChildWorkInput({
    childWorkId: host.childWorkId,
    parent: request.parent,
    provider: request.provider,
    kind: request.kind,
    state: request.state,
    membership: request.membership,
    ...mergeObservationFacts(parseObservationFacts(request, host), prior, run),
    firstObservedAt: host.firstObservedAt,
    observedAt: request.observedAt,
    ...(host.settledAt !== undefined ? { settledAt: host.settledAt } : {}),
    stoppable: request.stoppable,
    invocation: host.invocation,
    ...(host.previousInvocations !== undefined
      ? { previousInvocations: host.previousInvocations }
      : {}),
    provenance: request.provenance
  })
}

export function commitAgentChildWork(
  store: AgentStatusStore,
  child: AgentChildWorkInput,
  aliases: AgentChildWorkAliasInput[],
  created: boolean,
  removeAliases: string[] = []
): AgentChildWorkAdmissionResult {
  const envelope = store.applyMutation({
    children: [child],
    aliases,
    ...(removeAliases.length > 0 ? { removeAliases } : {})
  })
  return envelope
    ? { accepted: true, childWorkId: child.childWorkId, revision: envelope.revision, created }
    : rejectAgentChildWorkAdmission('store-rejected')
}

/** Settled history only gains precision: an `unknown` ending may become a definite one (a roster
 *  omission can land a tick before the frame naming the outcome), and a definite ending never
 *  changes to another. An omitted outcome counts as `unknown`. */
function conflictsWithSettled(
  child: AgentChildWorkRecord,
  request: AgentChildWorkAnnounceRequest | AgentChildWorkAdoptRequest
): boolean {
  const requested = request.outcome ?? 'unknown'
  return (
    request.membership !== 'settled' ||
    request.state !== child.state ||
    (requested !== 'unknown' && child.outcome !== 'unknown' && requested !== child.outcome)
  )
}

export function updateExistingAgentChildWork(
  store: AgentStatusStore,
  request: AgentChildWorkAnnounceRequest | AgentChildWorkAdoptRequest,
  child: AgentChildWorkRecord,
  aliases: AgentChildWorkAliasInput[],
  removeAliases: string[] = []
): AgentChildWorkAdmissionResult {
  if (child.membership === 'settled' && conflictsWithSettled(child, request)) {
    return rejectAgentChildWorkAdmission('stale-invocation')
  }
  const updated = buildAgentChildWork(
    request,
    {
      childWorkId: child.childWorkId,
      firstObservedAt: child.firstObservedAt,
      invocation: child.invocation,
      previousInvocations: child.previousInvocations,
      settledAt: agentChildWorkSettledAt(request, child)
    },
    child
  )
  return updated
    ? commitAgentChildWork(store, updated, aliases, false, removeAliases)
    : rejectAgentChildWorkAdmission('invalid')
}

export function resolveAgentChildWorkAliasRecords(
  store: AgentStatusStore,
  aliases: AgentChildWorkAliasInput[]
): AgentChildWorkAliasRecord[] {
  return store.resolveChildAliases(aliases)
}

export function validateExistingAgentChildWork(
  child: AgentChildWorkRecord | null,
  parent: AgentStatusSubject,
  provider: string,
  expectedFence: AgentChildWorkInvocationFence
): AgentChildWorkAdmissionResult | null {
  if (!child) {
    return rejectAgentChildWorkAdmission('unknown-child')
  }
  if (!agentStatusSubjectsEqual(child.parent, parent) || child.provider !== provider) {
    return rejectAgentChildWorkAdmission('ambiguous')
  }
  if (!agentChildWorkFencesEqual(child.invocation, expectedFence)) {
    return rejectAgentChildWorkAdmission('stale-invocation')
  }
  return null
}
