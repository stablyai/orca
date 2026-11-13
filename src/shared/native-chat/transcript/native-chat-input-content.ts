import { sha256 } from '@noble/hashes/sha256'
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils'
import type { AgentType } from '../../agent-status/contracts/agent-status-types'

/** Only complete source input units can originate a receipt. */
export type NativeChatInputContent = {
  provider: 'claude' | 'codex' | 'grok' | 'omp' | 'opencode'
  textDigest: string
  images: string[]
  /** The owning decoder read a provider-retained input, rather than a display projection. */
  retained?: true
}

export type NativeChatSourcePending = {
  sourceAgent?: AgentType
  text: string
  imagePaths?: readonly string[]
  afterMessageId?: string | null
  afterEmptyTranscriptSessionId?: string
}

/** Hash exact text only; attachment identity remains the ordered original paths. */
export function nativeChatInputTextDigest(text: string): string {
  return bytesToHex(sha256(utf8ToBytes(text)))
}
