import type { NativeChatMessage, NativeChatTextBlock } from './native-chat-types'

export const APPROVED_REVIEW =
  'Automatic approval review approved (risk: medium, authorization: high): The requested local check is allowed.'

export function approvalReviewBlock(text = APPROVED_REVIEW): NativeChatTextBlock {
  return {
    type: 'text',
    tone: 'warning',
    text,
    providerFrame: {
      provider: 'codex',
      kind: 'notification:guardianWarning',
      payload: {
        head: JSON.stringify({ message: text }),
        byteLength: text.length,
        digest: 'review-digest',
        truncated: false
      }
    }
  }
}

export function approvalReviewMessage(id: string, text = APPROVED_REVIEW): NativeChatMessage {
  return {
    id,
    role: 'system',
    blocks: [approvalReviewBlock(text)],
    timestamp: 1,
    source: 'transcript'
  }
}
