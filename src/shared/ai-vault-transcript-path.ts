import type { AiVaultSession } from './ai-vault-types'

export function getAiVaultTranscriptPath(
  session: Pick<AiVaultSession, 'filePath' | 'transcriptFilePath'>
): string | null {
  if (session.transcriptFilePath === null) {
    return null
  }
  return (session.transcriptFilePath ?? session.filePath).trim() || null
}
