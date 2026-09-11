export type AiVaultSessionMessageRole = 'user' | 'assistant' | 'tool' | 'error'

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
