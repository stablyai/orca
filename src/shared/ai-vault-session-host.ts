import { parseExecutionHostId } from './execution-host'
import type { AiVaultSession, AiVaultSessionHost } from './ai-vault-types'
import { isWslUncPath } from './wsl-paths'

export function deriveAiVaultSessionHost(
  session: Pick<AiVaultSession, 'cwd' | 'filePath'>
): AiVaultSessionHost {
  if (isWslSessionPath(session.cwd) || isWslSessionPath(session.filePath)) {
    return 'wsl'
  }
  return 'local'
}

// Why: SSH/runtime transcripts live on the owning host. Desktop rg/FTS would
// treat a missing remote POSIX path as an empty local miss.
export function sessionTranscriptIsRemoteOwned(
  session: Pick<AiVaultSession, 'executionHostId'>
): boolean {
  const parsed = parseExecutionHostId(session.executionHostId)
  return parsed?.kind === 'ssh' || parsed?.kind === 'runtime'
}

function isWslSessionPath(pathValue: string | null): boolean {
  if (!pathValue) {
    return false
  }
  return isWslUncPath(pathValue)
}
