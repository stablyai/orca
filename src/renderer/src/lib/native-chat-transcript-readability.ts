import { isRuntimeOwnedSshTargetId } from '../../../shared/execution-host'

/** Model-A SSH stores Grok transcripts on a host this renderer cannot read. */
export function isNativeChatTranscriptLocalReadable(
  connectionId: string | null | undefined
): boolean {
  return connectionId === null || isRuntimeOwnedSshTargetId(connectionId)
}
