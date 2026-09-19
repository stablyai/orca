export type AiVaultSessionMessageRole = 'user' | 'assistant' | 'tool' | 'error'

const AI_VAULT_SESSION_MESSAGE_ROLES: readonly AiVaultSessionMessageRole[] = [
  'user',
  'assistant',
  'tool',
  'error'
]

export function isAiVaultSessionMessageRole(value: unknown): value is AiVaultSessionMessageRole {
  return typeof value === 'string' && AI_VAULT_SESSION_MESSAGE_ROLES.some((role) => role === value)
}

export type AiVaultSessionMessageJump = {
  sessionId: string
  messageId: number
  filePath: string
  lineNumber: number
  byteOffset: number
  matchLength: number
}

export type AiVaultSessionMessageHit = {
  sessionId: string
  role: AiVaultSessionMessageRole
  snippet: string
  jump: AiVaultSessionMessageJump
}
