import type { AgentSessionFailureCopyId } from './agent-session-failure-copy'

import type { AgentSessionInstructionRecovery } from './agent-session-failure-details'
export type { AgentSessionInstructionRecovery } from './agent-session-failure-details'

export function instructionRecoveryCopy(
  reason: AgentSessionInstructionRecovery
): AgentSessionFailureCopyId {
  return (
    {
      timeout: 'instructionNotSent',
      pending: 'instructionPending',
      commit: 'instructionCommit',
      unsupported: 'instructionUpdate',
      unknown: 'instructionUnknown'
    } as const
  )[reason]
}

export const INSTRUCTION_RECOVERY_FAILURE_COPY = {
  instructionNotSent: 'Your message was not sent.',
  instructionPending:
    'Your message was not sent. The previous agent in this chat may still be running. Start a new chat to continue.',
  instructionCommit: "Orca couldn't save this to the chat's history. Your message was not sent.",
  instructionUpdate:
    'Your message was not sent. Update {{agent}} on the computer running this chat, then send it again.',
  instructionUnknown:
    "Your message was not sent. Orca couldn't prepare {{agent}} to start on the computer running this chat."
}
