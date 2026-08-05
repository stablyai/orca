import type { AiVaultAgent } from './ai-vault-types'
import {
  LOCAL_EXECUTION_HOST_ID,
  normalizeExecutionHostId,
  parseExecutionHostId,
  type ExecutionHostId
} from './execution-host'
import { parseWslUncPath } from './wsl-paths'

export type AiVaultResumeExecutionTargetStatus = 'local' | 'ssh' | 'runtime' | 'unknown'

export function canResumeAiVaultSessionInExecutionContext(args: {
  agent?: AiVaultAgent
  sessionFilePath?: string | null
  sessionExecutionHostId?: ExecutionHostId | null
  targetStatus: AiVaultResumeExecutionTargetStatus
  targetExecutionHostId?: ExecutionHostId | null
  targetWslDistro?: string | null
}): boolean {
  return args.agent === 'cursor'
    ? canResumeCursorInExecutionContext(args)
    : canResumeLegacySessionInExecutionContext(args)
}

function canResumeCursorInExecutionContext(
  args: Parameters<typeof canResumeAiVaultSessionInExecutionContext>[0]
): boolean {
  const sessionHost =
    normalizeExecutionHostId(args.sessionExecutionHostId) ?? LOCAL_EXECUTION_HOST_ID
  const targetHost = normalizeExecutionHostId(args.targetExecutionHostId)
  const parsedSessionHost = parseExecutionHostId(sessionHost)
  if (parsedSessionHost?.kind === 'ssh') {
    return args.targetStatus === 'ssh' && targetHost === sessionHost
  }
  if (parsedSessionHost?.kind === 'runtime') {
    return args.targetStatus === 'runtime' && targetHost === sessionHost
  }
  if (
    args.targetStatus !== 'local' ||
    (targetHost !== null && targetHost !== LOCAL_EXECUTION_HOST_ID)
  ) {
    return false
  }
  const sourceDistro = parseWslUncPath(args.sessionFilePath ?? '')?.distro.toLowerCase() ?? null
  const targetDistro = args.targetWslDistro?.trim().toLowerCase() || null
  return sourceDistro === targetDistro
}

function canResumeLegacySessionInExecutionContext(
  args: Parameters<typeof canResumeAiVaultSessionInExecutionContext>[0]
): boolean {
  const sessionHost = normalizeExecutionHostId(args.sessionExecutionHostId)
  const targetHost = normalizeExecutionHostId(args.targetExecutionHostId)
  if (args.targetStatus === 'runtime') {
    return Boolean(sessionHost && targetHost && sessionHost === targetHost)
  }
  if (args.targetStatus !== 'local' && args.targetStatus !== 'ssh') {
    return false
  }
  if (sessionHost && targetHost) {
    if (sessionHost === targetHost) {
      return true
    }
    return (
      sessionHost === LOCAL_EXECUTION_HOST_ID &&
      args.targetStatus === 'ssh' &&
      Boolean(parseWslUncPath(args.sessionFilePath ?? ''))
    )
  }
  if (sessionHost && sessionHost !== LOCAL_EXECUTION_HOST_ID) {
    return false
  }
  return args.targetStatus !== 'ssh' || Boolean(parseWslUncPath(args.sessionFilePath ?? ''))
}
