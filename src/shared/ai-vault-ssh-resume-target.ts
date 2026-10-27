import {
  LOCAL_EXECUTION_HOST_ID,
  normalizeExecutionHostId,
  type ExecutionHostId
} from './execution-host'
import { isWslUncPath } from './wsl-paths'
import { antigravitySessionOrigin } from './antigravity-session-origin'

/** Share host eligibility for SSH history resume across desktop/mobile. */
export function canResumeAiVaultSessionOnSshHost(args: {
  sessionFilePath: string | null | undefined
  sessionExecutionHostId?: ExecutionHostId | null
  targetExecutionHostId?: ExecutionHostId | null
}): boolean {
  const sessionHost = normalizeExecutionHostId(args.sessionExecutionHostId)
  const targetHost = normalizeExecutionHostId(args.targetExecutionHostId)
  const origin = args.sessionFilePath ? antigravitySessionOrigin(args.sessionFilePath) : null
  if (origin && origin !== 'antigravity-cli') {
    // File-based resumes require the transcript's host; the WSL exception applies only to ID resumes.
    return (
      (sessionHost ?? LOCAL_EXECUTION_HOST_ID) === targetHost &&
      !isWslUncPath(args.sessionFilePath ?? '')
    )
  }
  if (sessionHost && targetHost && sessionHost === targetHost) {
    return true
  }
  // Locally scanned WSL UNC transcripts may resume through SSH into that distro (#6270); other local paths do not exist remotely.
  return (
    (sessionHost ?? LOCAL_EXECUTION_HOST_ID) === LOCAL_EXECUTION_HOST_ID &&
    Boolean(args.sessionFilePath && isWslUncPath(args.sessionFilePath))
  )
}
