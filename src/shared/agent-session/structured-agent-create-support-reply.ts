/** Why a host cannot open a structured chat for an agent there; `windows`: none exists on a Windows host. */
export type StructuredAgentCreateSupportReason =
  | 'agent'
  | 'remote'
  | 'wsl'
  | 'windows'
  | 'chat-program'

/** The `agentSession.createSupport` reply, read by the desktop and the phone alike. */
export type StructuredAgentCreateSupportReply = {
  supported: boolean
  reason?: StructuredAgentCreateSupportReason
}
