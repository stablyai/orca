import { AI_VAULT_AGENTS, type AiVaultAgent } from '../../../shared/ai-vault-types'

export const AI_VAULT_SESSION_DRAG_TYPE = 'application/x-orca-ai-vault-session'
export const AI_VAULT_SESSION_DRAG_START_EVENT = 'orca-ai-vault-session-drag-start'
export const AI_VAULT_SESSION_DRAG_END_EVENT = 'orca-ai-vault-session-drag-end'

export type AiVaultSessionDragPayload = {
  agent: AiVaultAgent
  sessionId: string
  title: string
  command: string
}

let activeAiVaultSessionDragPayload: AiVaultSessionDragPayload | null = null

type SerializedAiVaultSessionDragPayload = AiVaultSessionDragPayload & {
  kind: 'ai-vault-session'
  version: 1
}

function isAiVaultAgent(value: unknown): value is AiVaultAgent {
  return typeof value === 'string' && (AI_VAULT_AGENTS as readonly string[]).includes(value)
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

function isSerializedPayload(value: unknown): value is SerializedAiVaultSessionDragPayload {
  if (!value || typeof value !== 'object') {
    return false
  }
  const payload = value as Partial<SerializedAiVaultSessionDragPayload>
  return (
    payload.kind === 'ai-vault-session' &&
    payload.version === 1 &&
    isAiVaultAgent(payload.agent) &&
    isNonEmptyString(payload.sessionId) &&
    isNonEmptyString(payload.title) &&
    isNonEmptyString(payload.command)
  )
}

export function writeAiVaultSessionDragData(
  dataTransfer: DataTransfer,
  payload: AiVaultSessionDragPayload
): void {
  activeAiVaultSessionDragPayload = { ...payload }
  dataTransfer.effectAllowed = 'copy'
  // Why: avoid text/plain so terminal/native drop targets cannot paste the
  // resume command instead of letting Orca's pane drop layer handle it.
  dataTransfer.setData(
    AI_VAULT_SESSION_DRAG_TYPE,
    JSON.stringify({ kind: 'ai-vault-session', version: 1, ...payload })
  )
}

export function hasAiVaultSessionDragData(dataTransfer: DataTransfer): boolean {
  return Array.from(dataTransfer.types).includes(AI_VAULT_SESSION_DRAG_TYPE)
}

export function clearAiVaultSessionDragData(): void {
  activeAiVaultSessionDragPayload = null
}

export function readAiVaultSessionDragData(
  dataTransfer: DataTransfer
): AiVaultSessionDragPayload | null {
  const raw = dataTransfer.getData(AI_VAULT_SESSION_DRAG_TYPE)
  if (!raw) {
    return hasAiVaultSessionDragData(dataTransfer) ? activeAiVaultSessionDragPayload : null
  }

  try {
    const parsed: unknown = JSON.parse(raw)
    if (!isSerializedPayload(parsed)) {
      return null
    }
    const { agent, sessionId, title, command } = parsed
    return { agent, sessionId, title, command }
  } catch {
    return null
  }
}
