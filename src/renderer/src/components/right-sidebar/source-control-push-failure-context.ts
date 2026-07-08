import { isPushHookFailure } from './push-failure-summary'

type PushFailureRemoteActionError = {
  kind: 'push' | 'publish' | 'force_push' | 'sync'
  message: string
  rawError?: string
}

const PUSH_FAILURE_REMOTE_OP_KINDS = new Set<PushFailureRemoteActionError['kind']>([
  'push',
  'publish',
  'force_push',
  'sync'
])

export function resolvePushFailureRawError(
  remoteActionError: { kind: string; message: string; rawError?: string } | null | undefined
): string | null {
  if (
    !remoteActionError ||
    !PUSH_FAILURE_REMOTE_OP_KINDS.has(
      remoteActionError.kind as PushFailureRemoteActionError['kind']
    )
  ) {
    return null
  }

  // Why: `message` is a user-facing summary; only raw git stderr is reliable for hook detection.
  const raw = remoteActionError.rawError
  if (!raw) {
    return null
  }
  return isPushHookFailure(raw) ? raw : null
}
