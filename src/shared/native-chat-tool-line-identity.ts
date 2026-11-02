import type { NativeChatBlock } from './native-chat-types'
import { summarizeToolInput } from './native-chat-tool-summary'

/** How much of an anonymous result's output identifies it, so a long log is never hashed whole. */
const RESULT_SIGNATURE_LENGTH = 160

/** Each repeated provider ID needs a separate row, while unrelated rows may move freely.
 *  `bounded` (mobile): a result keeps its call's ID through output updates, and a row with no
 *  ID is keyed by a bounded summary rather than its whole serialized input, so a refetched copy
 *  of the same row keeps its identity without paying for a large payload. */
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
