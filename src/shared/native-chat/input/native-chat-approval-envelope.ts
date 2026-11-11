import { nativeChatApprovalAcceptKey } from '../native-chat-agent-support'

/** The facts in a status row's `{ approval: { tool, summary } }` envelope; callers own labels. */
export type NativeChatApprovalEnvelope = {
  tool: string
  summary?: string
  /** Keys that answer the agent's default TUI approval prompt. */
  allowSend: string
  denySend: string
}

const ESCAPE = String.fromCharCode(27)
const TRUST_KEYS_RE = new RegExp(`^(?:${ESCAPE}\\[[AB])*\r$`)

function readEnvelopeField(
  interactivePrompt: string | undefined | null,
  key: string
): object | null {
  if (!interactivePrompt) {
    return null
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(interactivePrompt)
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return null
  }
  const field: unknown = Object.entries(parsed).find(([name]) => name === key)?.[1]
  return typeof field === 'object' && field !== null ? field : null
}

/** Read the approval envelope published in agentStatus.interactivePrompt on PermissionRequest. */
export function parseNativeChatApprovalEnvelope(
  interactivePrompt: string | undefined | null,
  agent?: string
): NativeChatApprovalEnvelope | null {
  const approval = readEnvelopeField(interactivePrompt, 'approval')
  if (!approval || !('tool' in approval)) {
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

/** A folder-trust dialog read off the screen; `trustSend` moves to the trust choice and confirms. */
/** A null `trustSend` means the trust choice could not be aimed; the card then offers only Exit. */
export function buildNativeChatFolderTrustPrompt(trustSend: string | null): string {
  return JSON.stringify({ folderTrust: trustSend ? { trustSend } : {} })
}

export function parseNativeChatFolderTrustEnvelope(
  interactivePrompt: string | undefined | null
): { trustSend: string | null; exitSend: string } | null {
  const trust = readEnvelopeField(interactivePrompt, 'folderTrust')
  if (!trust) {
    return null
  }
  if (!('trustSend' in trust)) {
    return { trustSend: null, exitSend: ESCAPE }
  }
  const trustSend = trust.trustSend
  // Only arrow keys then Return; anything else is not a trust-choice keystroke.
  if (typeof trustSend !== 'string' || !TRUST_KEYS_RE.test(trustSend)) {
    return null
  }
  return { trustSend, exitSend: ESCAPE }
}
