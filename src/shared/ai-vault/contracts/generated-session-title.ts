import { aiVaultAgentLabel, type AiVaultAgent } from './ai-vault-types'

/** The name a session gets when its transcript has no title or prompt yet: "Claude 6ebe07c5". */
export function generatedAiVaultSessionTitle(agent: AiVaultAgent, sessionId: string): string {
  return `${aiVaultAgentLabel(agent)} ${sessionId.slice(0, 8)}`
}
