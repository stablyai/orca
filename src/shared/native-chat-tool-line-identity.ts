import type { NativeChatBlock } from './native-chat-types'
import { summarizeToolInput } from './native-chat-tool-summary'

/** How much of an anonymous result's output identifies it, so a long log is never hashed whole. */
const RESULT_SIGNATURE_LENGTH = 160

/** Repeated provider IDs remain separate. Mobile bounded identity keeps result/call ids stable through output updates,
 * using capped summaries for anonymous rows so refetches retain keys without hashing whole payloads. */
export function nativeChatToolLineIdentity(
  block: NativeChatBlock,
  seen: Map<string, number>,
  bounded = false
): string {
  const providerCallId =
    (block.type === 'tool-call' || (bounded && block.type === 'tool-result')) &&
    block.callId !== undefined &&
    block.callId.trim().length > 0
      ? block.callId
      : undefined
  const providerKind = block.type === 'tool-result' ? 'result' : 'call'
  const signature =
    providerCallId !== undefined
      ? `${providerKind}:${providerCallId}`
      : block.type === 'tool-call'
        ? `${block.type}:${block.name}:${bounded ? summarizeToolInput(block.input) : JSON.stringify(block.input)}`
        : block.type === 'tool-result'
          ? `${block.type}:${bounded ? block.output.slice(0, RESULT_SIGNATURE_LENGTH) : block.output}`
          : `${block.type}`
  const occurrence = seen.get(signature) ?? 0
  seen.set(signature, occurrence + 1)
  if (providerCallId === undefined) {
    return `${signature}:${occurrence}`
  }
  return occurrence === 0
    ? signature
    : `${providerKind}-occurrence:${JSON.stringify([providerCallId, occurrence])}`
}
