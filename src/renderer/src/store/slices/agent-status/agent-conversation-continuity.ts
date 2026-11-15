import type { AgentStatusEntry } from '../../../../../shared/agent-status/contracts/agent-status-types'
import type { AgentStatusObservation } from '../../../../../shared/agent-status/contracts/agent-status-observation'
import { isCommandCodeNewTurnWhileWorking } from '../../../../../shared/command-code-turn-boundary'

export type AgentConversationSource = Partial<
  Pick<
    AgentStatusEntry,
    | 'state'
    | 'stateStartedAt'
    | 'turnStartedAt'
    | 'promptInteractionKey'
    | 'prompt'
    | 'providerSession'
    | 'firstStateStartedAt'
  >
> & { observation?: AgentStatusObservation; isReplay?: boolean; identityOnly?: boolean }

export type AgentConversationContinuity = Pick<AgentStatusEntry, 'state'> &
  Partial<
    Pick<AgentStatusEntry, 'stateStartedAt' | 'turnStartedAt' | 'promptInteractionKey' | 'prompt'>
  > & {
    observation?: Pick<AgentStatusObservation, 'authorityId' | 'incarnation' | 'revision'>
  }

export function normalizedConversationPrompt(prompt: string | undefined): string | undefined {
  return prompt?.trim().replace(/\s+/g, ' ').toLowerCase().slice(0, 1024) || undefined
}

export function classifyConversationContinuity(
  previous: AgentConversationContinuity | undefined,
  source: AgentConversationSource,
  agentType: AgentStatusEntry['agentType'],
  confirmedProvider: boolean
): {
  successor: boolean
  continuity: AgentConversationContinuity | undefined
  stale?: boolean
  newTurnStartedAt?: number
} {
  if (source.identityOnly || source.observation?.kind === 'identity-only' || !source.state) {
    return { successor: false, continuity: previous }
  }
  const before = previous?.observation
  const after = source.observation
  const comparable = before && after ? before.authorityId === after.authorityId : !before && !after
  const ordered = before && after && comparable
  const sameTurn = Boolean(
    previous &&
    ((source.turnStartedAt !== undefined &&
      comparable &&
      source.turnStartedAt === previous.turnStartedAt) ||
      (source.promptInteractionKey &&
        source.promptInteractionKey === previous.promptInteractionKey))
  )
  const newTurn = Boolean(
    previous &&
    ((source.turnStartedAt !== undefined &&
      previous.turnStartedAt !== undefined &&
      comparable &&
      source.turnStartedAt > previous.turnStartedAt) ||
      (source.promptInteractionKey &&
        previous.promptInteractionKey &&
        source.promptInteractionKey !== previous.promptInteractionKey))
  )
  const incarnationChanged = Boolean(ordered && after.incarnation > before.incarnation)
  const replay = after?.kind === 'snapshot' || (source.isReplay && after?.kind !== 'transition')
  const staleRevision = Boolean(
    ordered &&
    (after.incarnation < before.incarnation ||
      (after.incarnation === before.incarnation && after.revision <= before.revision))
  )
  const stalePhase = Boolean(
    previous &&
    comparable &&
    !incarnationChanged &&
    !newTurn &&
    (!ordered || replay) &&
    source.stateStartedAt !== undefined &&
    previous.stateStartedAt !== undefined &&
    source.stateStartedAt <= previous.stateStartedAt
  )
  if (staleRevision || stalePhase) {
    return { successor: false, continuity: previous, stale: true }
  }
  const newTurnStartedAt =
    previous &&
    comparable &&
    source.turnStartedAt !== undefined &&
    previous.turnStartedAt !== undefined &&
    source.turnStartedAt > previous.turnStartedAt
      ? source.turnStartedAt
      : undefined
  const sourceAdvanced = Boolean(
    previous &&
    comparable &&
    source.stateStartedAt !== undefined &&
    previous.stateStartedAt !== undefined &&
    source.stateStartedAt > previous.stateStartedAt
  )
  const transition = !source.isReplay && source.observation?.kind !== 'snapshot'
  const phaseSuccessor =
    previous?.state === 'done' && source.state !== 'done' && (transition || sourceAdvanced)
  const commandCodeTurn = isCommandCodeNewTurnWhileWorking({
    agentType,
    previousState: previous?.state,
    incomingState: source.state,
    previousPrompt: previous?.prompt,
    incomingPrompt: source.prompt?.trim().slice(0, 1024) ?? '',
    previousPromptInteractionKey: previous?.promptInteractionKey,
    incomingPromptInteractionKey: source.promptInteractionKey
  })
  const boundary = Boolean(after?.boundary && after.kind === 'transition')
  const successor =
    !confirmedProvider &&
    Boolean(
      incarnationChanged ||
      newTurn ||
      (!sameTurn && (phaseSuccessor || commandCodeTurn || boundary))
    )
  const meaningful =
    !previous ||
    successor ||
    newTurn ||
    incarnationChanged ||
    previous.state !== source.state ||
    commandCodeTurn
  if (!meaningful) {
    return { successor, continuity: previous }
  }
  return {
    successor,
    newTurnStartedAt,
    continuity: {
      state: source.state,
      ...(source.stateStartedAt !== undefined ? { stateStartedAt: source.stateStartedAt } : {}),
      ...(source.turnStartedAt !== undefined ? { turnStartedAt: source.turnStartedAt } : {}),
      ...(source.promptInteractionKey ? { promptInteractionKey: source.promptInteractionKey } : {}),
      ...(source.prompt?.trim() ? { prompt: source.prompt.trim().slice(0, 1024) } : {}),
      ...(after
        ? {
            observation: {
              authorityId: after.authorityId,
              incarnation: after.incarnation,
              revision: after.revision
            }
          }
        : {})
    }
  }
}
