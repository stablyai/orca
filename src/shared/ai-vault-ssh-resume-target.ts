import {
  LOCAL_EXECUTION_HOST_ID,
  normalizeExecutionHostId,
  type ExecutionHostId
} from './execution-host'
import { isWslUncPath } from './wsl-paths'
import { antigravitySessionOrigin } from './antigravity-session-origin'

/**
 * Whether a history session can resume in an SSH workspace on `targetExecutionHostId`.
 * Shared by desktop and mobile so both apply the same host rule.
 */
export function canResumeAiVaultSessionOnSshHost(args: {
  sessionFilePath: string | null | undefined
  sessionExecutionHostId?: ExecutionHostId | null
  targetExecutionHostId?: ExecutionHostId | null
}): boolean {
  const sessionHost = normalizeExecutionHostId(args.sessionExecutionHostId)
  const targetHost = normalizeExecutionHostId(args.targetExecutionHostId)
  const origin = args.sessionFilePath ? antigravitySessionOrigin(args.sessionFilePath) : null
  if (origin && origin !== 'antigravity-cli') {
    // Why: these resumes reference the transcript file itself, so only its own host can open it;
    // the WSL exception below holds only for ID-based resumes.
    return (
      (sessionHost ?? LOCAL_EXECUTION_HOST_ID) === targetHost &&
      !isWslUncPath(args.sessionFilePath ?? '')
    )
  }
  if (sessionHost && targetHost && sessionHost === targetHost) {
    return true
  }
  // Why: SSH-to-local-WSL setups (#6270) scan the WSL home from this machine, so the row is
  // stamped local, but its WSL UNC transcript is what the SSH shell into that distro reads.
  // Any other host-local transcript does not exist on the remote filesystem.
  return (
    (sessionHost ?? LOCAL_EXECUTION_HOST_ID) === LOCAL_EXECUTION_HOST_ID &&
    Boolean(args.sessionFilePath && isWslUncPath(args.sessionFilePath))
  )
}
