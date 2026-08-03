import { isRuntimeOwnedSshTargetId } from '../../../../shared/execution-host'
import { isNativeChatTranscriptLocalReadable } from '@/lib/native-chat-transcript-readability'

export type CodexSubagentProgressRoute =
  | { kind: 'readable'; runtimeEnvironmentId: string | null }
  | { kind: 'unavailable'; reason: 'unknown-owner' | 'legacy-ssh' | 'runtime-owner-missing' }

export function resolveCodexSubagentProgressRoute(
  connectionId: string | null | undefined,
  runtimeEnvironmentId: string | null
): CodexSubagentProgressRoute {
  if (connectionId === undefined) {
    return { kind: 'unavailable', reason: 'unknown-owner' }
  }
  if (!isNativeChatTranscriptLocalReadable(connectionId)) {
    return { kind: 'unavailable', reason: 'legacy-ssh' }
  }
  if (isRuntimeOwnedSshTargetId(connectionId)) {
    return runtimeEnvironmentId
      ? { kind: 'readable', runtimeEnvironmentId }
      : { kind: 'unavailable', reason: 'runtime-owner-missing' }
  }
  return { kind: 'readable', runtimeEnvironmentId: null }
}
