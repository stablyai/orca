import { nativeChatApprovalAcceptKey } from './native-chat/native-chat-agent-support'

/** The facts in a status row's `{ approval: { tool, summary } }` envelope; callers own labels. */
export type NativeChatApprovalEnvelope = {
  tool: string
  summary?: string
  /** Keys that answer the agent's default TUI approval prompt. */
  allowSend: string
  denySend: string
}

const ESCAPE = String.fromCharCode(27)
const MENU_KEYS_RE = new RegExp(`^(?:${ESCAPE}\\[[AB])*\r$`)

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
  if (typeof trustSend !== 'string' || !MENU_KEYS_RE.test(trustSend)) {
    return null
  }
  return { trustSend, exitSend: ESCAPE }
}

export type NativeChatStartupMenuChoice = { label: string; send: string }

const STARTUP_MENU_TEXT_MAX = 300
const STARTUP_MENU_CHOICES_MAX = 9

function isStartupMenuText(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= STARTUP_MENU_TEXT_MAX
}

/** A startup menu read off the screen; no choices means only the terminal can answer it. */
export function buildNativeChatStartupMenuPrompt(menu: {
  description?: string
  choices: NativeChatStartupMenuChoice[]
}): string {
  return JSON.stringify({ startupMenu: menu })
}

export function parseNativeChatStartupMenuEnvelope(
  interactivePrompt: string | undefined | null
): { description?: string; choices: NativeChatStartupMenuChoice[] } | null {
  const menu = readEnvelopeField(interactivePrompt, 'startupMenu')
  if (!menu || !('choices' in menu) || !Array.isArray(menu.choices)) {
    return null
  }
  const choices: NativeChatStartupMenuChoice[] = []
  for (const choice of menu.choices.slice(0, STARTUP_MENU_CHOICES_MAX)) {
    const label: unknown = choice?.label
    const send: unknown = choice?.send
    // Only arrow keys then Return; anything else is not a menu-choice keystroke.
    if (!isStartupMenuText(label) || typeof send !== 'string' || !MENU_KEYS_RE.test(send)) {
      return null
    }
    choices.push({ label, send })
  }
  const description = 'description' in menu ? menu.description : undefined
  return { ...(isStartupMenuText(description) ? { description } : {}), choices }
}
