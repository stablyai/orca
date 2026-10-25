import { nativeChatApprovalAcceptKey } from './native-chat-agent-support'

/** The facts in a status row's `{ approval: { tool, summary } }` envelope; callers own labels. */
export type NativeChatApprovalEnvelope = {
  tool: string
  summary?: string
  /** Keys that answer the agent's default TUI approval prompt. */
  allowSend: string
  denySend: string
}

const ESCAPE = String.fromCharCode(27)

/** Parse the approval envelope the host writes to `agentStatus.interactivePrompt` on a PermissionRequest. */
export function parseNativeChatApprovalEnvelope(
  interactivePrompt: string | undefined | null,
  agent?: string
): NativeChatApprovalEnvelope | null {
  if (!interactivePrompt) {
    return null
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(interactivePrompt)
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null || !('approval' in parsed)) {
    return null
  }
  const approval = parsed.approval
  if (typeof approval !== 'object' || approval === null || !('tool' in approval)) {
    return null
  }
  const tool = approval.tool
  if (typeof tool !== 'string' || tool.length === 0) {
    return null
  }
  const summary = 'summary' in approval ? approval.summary : undefined
  return {
    tool,
    ...(typeof summary === 'string' && summary.length > 0 ? { summary } : {}),
    allowSend: nativeChatApprovalAcceptKey(agent),
    denySend: ESCAPE
  }
}
