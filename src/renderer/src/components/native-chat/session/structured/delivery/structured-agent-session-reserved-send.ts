import type { AgentJournalCursor } from '../../../../../../../shared/agent-session/journal/agent-session-journal-identity'
import type { AgentJournalSubmission } from '../../../../../../../shared/agent-session/journal/agent-session-journal-types'
import type { StructuredAgentSessionFirstMessage } from '../../../../../../../shared/agent-session/lifecycle/operations/structured-agent-session-create'
import type { AgentSessionWriteFailure } from '../../../../../../../shared/agent-session/failures/agent-session-write-failure'
import type { RuntimeClientTarget } from '../../../../../../../shared/remote-runtime/host-catalog/runtime-client-target'
import type { StructuredAgentSessionSendInput } from './structured-agent-session-send-slot'
import type {
  StructuredAgentSessionHandBackCustody,
  StructuredAgentSessionSendOutcome,
  StructuredAgentSessionSent
} from './structured-agent-session-send-runtime'

// The handles a reserved send gives its holder (see `reserveStructuredAgentSessionSend`).

export type StructuredAgentSessionReservedSend = {
  clientMessageId: string
  fail: (notice: string) => void
  outcome: Promise<StructuredAgentSessionSendOutcome>
  /** Resolves once the host records this send, even after an `unconfirmed` outcome. */
  recorded: Promise<void>
  /** Older creates wait for acquisition; their send budget still begins at send. */
  legacy: () => void
  active: () => boolean
  prepare: (
    input: Pick<StructuredAgentSessionSendInput, 'text' | 'attachments' | 'skills'>,
    /** The preparation's custody grant, checked at the issue (see `grantStructuredAgentSessionSendCustody`). */
    custodyLost?: () => readonly string[]
  ) => boolean
  /** What this send's hand-back left of its input, once it was handed back; undefined otherwise. */
  handedBack: () => StructuredAgentSessionHandBackCustody | undefined
  /** Sends it once the chat exists; null when the reservation was released or dropped meanwhile. */
  send: (target: RuntimeClientTarget) => StructuredAgentSessionSent | null
  /** The same message, owned by create instead of a later send request. */
  create: (target: RuntimeClientTarget) => StructuredAgentSessionCreateSend | null
  release: () => void
}

export type StructuredAgentSessionCreateSend = StructuredAgentSessionSent & {
  message: StructuredAgentSessionFirstMessage
  issue: () => boolean
  settle: (
    result:
      | { kind: 'recorded'; submission: AgentJournalSubmission; cursor?: AgentJournalCursor }
      | { kind: 'refused'; failure?: AgentSessionWriteFailure }
      | { kind: 'unconfirmed' }
  ) => void
}
