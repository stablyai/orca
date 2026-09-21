// Reads the complete original of a bounded block through `agentSession.readPayload`.
// The pane that owns the session supplies the reader through context; a block
// rendered outside such a pane (search results, tests) has no reader and shows
// no full-content affordance, so a preview is never mistaken for retrievable.

import { createContext, useContext, useMemo } from 'react'
import type { RuntimeClientTarget } from '@/runtime/runtime-rpc-client'
import { callStructuredAgentSession } from '@/runtime/structured-agent-session-client'

export type NativeChatPayloadReader = {
  /** Resolves the exact original text; rejects with the host's error code
   *  (`payload_not_referenced`, `payload_integrity_failed`, ...). */
  readFullPayload(digest: string, expectedByteLength: number): Promise<string>
}

type PayloadRange = {
  digest: string
  byteLength: number
  chunk: string
  chunkOffset: number
  chunkByteLength: number
  complete: boolean
}

/** Largest chunk the host serves per call; matches AGENT_SESSION_PAYLOAD_READ_MAX_LIMIT. */
const PAGE_LIMIT = 256 * 1024
/** Hard stop against a host that never reports `complete`. */
const MAX_PAGES = 1024

export const NativeChatPayloadReaderContext = createContext<NativeChatPayloadReader | null>(null)

/** The reader for the surrounding session pane, or null outside one. */
export function useNativeChatPayloadReader(): NativeChatPayloadReader | null {
  return useContext(NativeChatPayloadReaderContext)
}

/** Pages `agentSession.readPayload` until the host reports the payload complete,
 *  re-checking the digest and total length on every page so a payload that
 *  changed underneath the read is refused rather than stitched together. */
export function createSessionPayloadReader(
  target: RuntimeClientTarget,
  sessionId: string
): NativeChatPayloadReader {
  return {
    async readFullPayload(digest, expectedByteLength) {
      const parts: string[] = []
      let offset = 0
      for (let page = 0; page < MAX_PAGES; page += 1) {
        const range = await callStructuredAgentSession<PayloadRange>(
          target,
          'agentSession.readPayload',
          { sessionId, digest, offset, limit: PAGE_LIMIT }
        )
        if (range.digest !== digest || range.byteLength !== expectedByteLength) {
          throw new Error('payload_identity_changed')
        }
        parts.push(range.chunk)
        offset = range.chunkOffset + range.chunkByteLength
        if (range.complete) {
          return parts.join('')
        }
        if (range.chunkByteLength === 0) {
          break
        }
      }
      throw new Error('payload_incomplete')
    }
  }
}

/**
 * Reader for a structured agent-session pane. `sessionId` must be the structured
 * agent-session RECORD id, which is what the host resolves the owning journal
 * from — a provider session id looks similar and reads as `payload_not_referenced`.
 */
export function useStructuredSessionPayloadReader(
  target: RuntimeClientTarget,
  sessionId: string | null | undefined
): NativeChatPayloadReader | null {
  return useMemo(
    () => (sessionId ? createSessionPayloadReader(target, sessionId) : null),
    [target, sessionId]
  )
}
