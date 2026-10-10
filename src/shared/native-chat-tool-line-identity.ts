import type { NativeChatBlock } from './native-chat-types'

const anonymousRows = new WeakMap<NativeChatBlock, number>()
let nextAnonymousRow = 0

/** Each repeated provider ID needs a separate row, while unrelated rows may move freely. */
export function nativeChatToolLineIdentity(
  block: NativeChatBlock,
  seen: Map<string, number>,
  preserveAnonymousObject = false
): string {
  const providerCallId =
    (block.type === 'tool-call' || (preserveAnonymousObject && block.type === 'tool-result')) &&
    block.callId !== undefined &&
    block.callId.trim().length > 0
      ? block.callId
      : undefined
  if (providerCallId === undefined && preserveAnonymousObject) {
    const id = anonymousRows.get(block) ?? nextAnonymousRow++
    anonymousRows.set(block, id)
    const signature = `anonymous:${id}`
    const occurrence = seen.get(signature) ?? 0
    seen.set(signature, occurrence + 1)
    return `${signature}:${occurrence}`
  }
  const providerKind = block.type === 'tool-result' ? 'result' : 'call'
  const signature =
    providerCallId !== undefined
      ? `${providerKind}:${providerCallId}`
      : block.type === 'tool-call'
        ? `${block.type}:${block.name}:${JSON.stringify(block.input)}`
        : block.type === 'tool-result'
          ? `${block.type}:${block.output}`
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
