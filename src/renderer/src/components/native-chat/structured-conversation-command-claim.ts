import {
  isAgentSessionConversationCommandResult,
  type AgentSessionConversationCommand,
  type AgentSessionConversationCommandResult
} from '../../../../shared/agent-session-conversation-command'
import { agentJournalSubmissionKey } from '../../../../shared/agent-session-journal-item-key'
import type { AgentJournalRenderItem } from '../../../../shared/agent-session-journal-types'
import { readAgentJournalTurn } from '../../../../shared/agent-session-turn-record'
import { translate } from '@/i18n/i18n'

export type ConversationCommandOutcome = { accepted: boolean; error: string | null }
export type ConversationCommandClaimOutcome = ConversationCommandOutcome & {
  retrySameOperation?: true
}
export type ConversationCommandReply =
  | { status: 'completed'; result: AgentSessionConversationCommandResult }
  | { status: 'refused'; error: string | null }
  | { status: 'unresolved' }

type Obligation = {
  command: AgentSessionConversationCommand
  operationId: string
}

type LiveClaim = Obligation & {
  generation: number
  deadline: ReturnType<typeof setTimeout>
  settle: (outcome: ConversationCommandClaimOutcome) => void
  onLateReply: () => void
}

type ClaimObserver = Obligation & {
  deadline: ReturnType<typeof setTimeout>
}

/** The provider's own completion window is 180s. Keep a small margin for host persistence and
 * stream delivery before presenting the command as unresolved. */
export const CONVERSATION_COMMAND_DEADLINE_MS = 195_000

function message(key: string, fallback: string): string {
  return translate(`components.native-chat.conversationCommand.${key}`, fallback)
}

function unresolvedMessage(command: AgentSessionConversationCommand): string {
  return translate(
    'components.native-chat.conversationCommand.mayStillBeRunning',
    'The previous /{{value0}} could not be confirmed. Retry the command to check its status.',
    { value0: command }
  )
}

function terminalFrameOutcome(
  items: readonly AgentJournalRenderItem[],
  claim: Obligation
): ConversationCommandOutcome | null {
  const item = items.find(
    (entry) => entry.itemId === agentJournalSubmissionKey(`${claim.command}:${claim.operationId}`)
  )
  if (item?.body.kind !== 'status') {
    return null
  }
  const lifecycle = readAgentJournalTurn(item.body)
  if (lifecycle?.state === 'running') {
    return null
  }
  if (
    lifecycle?.state === 'unverifiable' ||
    (lifecycle === null && item.body.text === 'Compaction completion is unconfirmed.')
  ) {
    return { accepted: false, error: unresolvedMessage(claim.command) }
  }
  const completedText =
    claim.command === 'compact' ? 'Conversation compacted.' : 'Conversation cleared.'
  return (lifecycle === null || lifecycle.state === 'completed') && item.body.text === completedText
    ? { accepted: true, error: null }
    : { accepted: false, error: item.body.text }
}

/** A reply the host could not confirm; retries must keep the same durable operation id. */
export function isUnconfirmedConversationCommand(method: string, value: unknown): boolean {
  return (
    method === 'agentSession.conversationCommand' &&
    isAgentSessionConversationCommandResult(value) &&
    value.state === 'unknown'
  )
}

/** Correlates one in-flight request with host lifecycle. Durable ownership remains on the host. */
export class StructuredConversationCommandClaim {
  private live: LiveClaim | null = null
  private readonly observers = new Map<string, ClaimObserver>()
  private generation = 0

  constructor(private readonly deadlineMs = CONVERSATION_COMMAND_DEADLINE_MS) {}

  get isRunning(): boolean {
    return this.live !== null
  }

  isOperationOutstanding(operationId: string): boolean {
    return (
      this.live?.operationId === operationId ||
      [...this.observers.values()].some((observer) => observer.operationId === operationId)
    )
  }

  run(input: {
    command: AgentSessionConversationCommand
    operationId: string
    blocked: boolean
    send: () => Promise<ConversationCommandReply>
    onLateReply?: () => void
  }): Promise<ConversationCommandClaimOutcome> {
    if (this.live || input.blocked) {
      return Promise.resolve({
        accepted: false,
        error: message(
          this.live ? 'running' : 'pendingWork',
          this.live
            ? 'Wait for the conversation operation to finish.'
            : 'Wait for pending work and messages to finish before using this command.'
        )
      })
    }
    this.removeObserver(input.command, input.operationId)
    const waiter = Promise.withResolvers<ConversationCommandClaimOutcome>()
    const claim: LiveClaim = {
      command: input.command,
      operationId: input.operationId,
      generation: this.generation,
      deadline: setTimeout(() => this.expire(claim), this.deadlineMs),
      settle: waiter.resolve,
      onLateReply: input.onLateReply ?? (() => {})
    }
    this.live = claim
    // Transport doubt cannot settle host-owned work; the session lifecycle or claim deadline does.
    void input.send().then(
      (reply) => this.applyReply(claim, reply),
      () => undefined
    )
    return waiter.promise
  }

  applyStreamSnapshot(items: readonly AgentJournalRenderItem[]): string[] {
    const settledOperationIds: string[] = []
    if (this.live) {
      const outcome = terminalFrameOutcome(items, this.live)
      if (outcome) {
        settledOperationIds.push(this.live.operationId)
        this.finish(this.live, outcome)
      }
    }
    for (const [key, observer] of this.observers) {
      const outcome = terminalFrameOutcome(items, observer)
      if (outcome) {
        clearTimeout(observer.deadline)
        this.observers.delete(key)
        settledOperationIds.push(observer.operationId)
      }
    }
    return settledOperationIds
  }

  reset(retryPreparedClear = false): void {
    this.generation++
    if (this.live) {
      this.finish(this.live, {
        accepted: false,
        error: message('unconfirmed', 'Conversation operation was not confirmed.'),
        ...(retryPreparedClear && this.live.command === 'clear'
          ? { retrySameOperation: true as const }
          : {})
      })
    }
    for (const observer of this.observers.values()) {
      clearTimeout(observer.deadline)
    }
    this.observers.clear()
  }

  private applyReply(claim: LiveClaim, reply: ConversationCommandReply): void {
    if (claim.generation !== this.generation) {
      return
    }
    if (this.live !== claim) {
      if (reply.status === 'unresolved') {
        return
      }
      if (
        this.live?.generation === claim.generation &&
        this.live.command === claim.command &&
        this.live.operationId === claim.operationId
      ) {
        this.applyReply(this.live, reply)
        return
      }
      this.removeObserver(claim.command, claim.operationId)
      claim.onLateReply()
      return
    }
    if (reply.status === 'unresolved') {
      return
    }
    if (reply.status === 'refused') {
      this.finish(claim, {
        accepted: false,
        error: reply.error ?? message('unconfirmed', 'Conversation operation was not confirmed.')
      })
      return
    }
    if (reply.result.state === 'unknown') {
      this.finishUnconfirmed(claim)
      return
    }
    this.finish(claim, {
      accepted: !reply.result.error,
      error: reply.result.error ?? null
    })
  }

  private finishUnconfirmed(claim: LiveClaim): void {
    if (this.live !== claim) {
      return
    }
    clearTimeout(claim.deadline)
    this.live = null
    this.observe(claim)
    claim.settle({
      accepted: false,
      error: unresolvedMessage(claim.command),
      retrySameOperation: true
    })
  }

  private finish(claim: LiveClaim, outcome: ConversationCommandClaimOutcome): void {
    if (this.live !== claim) {
      return
    }
    clearTimeout(claim.deadline)
    this.live = null
    claim.settle(outcome)
  }

  private expire(claim: LiveClaim): void {
    if (this.live !== claim) {
      return
    }
    this.live = null
    this.observe(claim)
    claim.settle({
      accepted: false,
      error: unresolvedMessage(claim.command),
      retrySameOperation: true
    })
  }

  private observe(claim: LiveClaim): void {
    const key = this.observerKey(claim.command, claim.operationId)
    const observer: ClaimObserver = {
      command: claim.command,
      operationId: claim.operationId,
      deadline: setTimeout(() => {
        if (this.observers.get(key) === observer) {
          this.observers.delete(key)
        }
      }, this.deadlineMs)
    }
    this.observers.set(key, observer)
  }

  private observerKey(command: AgentSessionConversationCommand, operationId: string): string {
    return `${command}:${operationId}`
  }

  private removeObserver(command: AgentSessionConversationCommand, operationId: string): void {
    const key = this.observerKey(command, operationId)
    const observer = this.observers.get(key)
    if (!observer) {
      return
    }
    clearTimeout(observer.deadline)
    this.observers.delete(key)
  }
}
