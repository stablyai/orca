/** Why a host cannot open a structured chat for an agent there. */
export type StructuredAgentCreateSupportReason = 'agent' | 'remote' | 'wsl' | 'chat-program'

/** The `agentSession.createSupport` reply, read by the desktop and the phone alike. */
export type StructuredAgentCreateSupportReply = {
  supported: boolean
  reason?: StructuredAgentCreateSupportReason
}
