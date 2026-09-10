import type { ParsedAgentStatusPayload } from './agent-status-types'
import { parseAgentStatusPayload } from './agent-status-types'
import { ownRetainedString } from './own-retained-string'

const OSC_AGENT_STATUS_PREFIX = '\x1b]9999;'

/** Return a suffix that can only be the beginning of an OSC 9999 marker. */
function findAgentStatusPrefixCarry(data: string): string {
  const lastChar = data.charCodeAt(data.length - 1)
  if (lastChar !== 0x1b && lastChar !== 0x5d && lastChar !== 0x39 && lastChar !== 0x3b) {
    return ''
  }
  const maxCarryLength = Math.min(data.length, OSC_AGENT_STATUS_PREFIX.length - 1)
  for (let length = maxCarryLength; length > 0; length -= 1) {
    const suffix = data.slice(data.length - length)
    if (OSC_AGENT_STATUS_PREFIX.startsWith(suffix)) {
      return suffix
    }
  }
  return ''
}

export type ProcessedAgentStatusChunk = {
  cleanData: string
  payloads: ParsedAgentStatusPayload[]
  lastPayloadCleanOffset: number | null
}

function findAgentStatusTerminator(
  data: string,
  searchFrom: number,
  next: { belIndex: number; stIndex: number }
): { index: number; length: 1 | 2 } | null {
  // Reuse forward matches, including absence, for this chunk's remaining frames.
  // Requires `searchFrom` to increase on every call for one `data`; a rewind would
  // reuse a match that is no longer the earliest.
  if (next.belIndex !== -1 && next.belIndex < searchFrom) {
    next.belIndex = data.indexOf('\x07', searchFrom)
  }
  if (next.stIndex !== -1 && next.stIndex < searchFrom) {
    next.stIndex = data.indexOf('\x1b\\', searchFrom)
  }
  if (next.belIndex === -1 && next.stIndex === -1) {
    return null
  }
  if (next.stIndex === -1 || (next.belIndex !== -1 && next.belIndex < next.stIndex)) {
    return { index: next.belIndex, length: 1 }
  }
  return { index: next.stIndex, length: 2 }
}

/**
 * Stateful OSC 9999 parser for PTY streams.
 * Why: hidden/model-owned terminal output needs the same agent-status parsing
 * as mounted terminal panes, even when no terminal view is rendered.
 */
export function createAgentStatusOscProcessor(): (data: string) => ProcessedAgentStatusChunk {
  const MAX_PENDING = 64 * 1024
  let pending = ''

  return (data: string): ProcessedAgentStatusChunk => {
    // Ordinary terminal output is by far the common case. Keep it on the
    // identity path unless the chunk ends with a split OSC marker; this avoids
    // rebuilding a clean-data string for every PTY frame.
    if (pending.length === 0 && !data.includes(OSC_AGENT_STATUS_PREFIX)) {
      const carry = findAgentStatusPrefixCarry(data)
      if (carry.length === 0) {
        return { cleanData: data, payloads: [], lastPayloadCleanOffset: null }
      }
      pending = carry
      return {
        cleanData: data.slice(0, data.length - carry.length),
        payloads: [],
        lastPayloadCleanOffset: null
      }
    }

    const combined = pending + data
    pending = ''

    const payloads: ParsedAgentStatusPayload[] = []
    let lastPayloadCleanOffset: number | null = null
    let cleanData = ''
    let cursor = 0
    const nextTerminator = { belIndex: 0, stIndex: 0 }

    while (cursor < combined.length) {
      const start = combined.indexOf(OSC_AGENT_STATUS_PREFIX, cursor)
      if (start === -1) {
        const tail = combined.slice(cursor)
        const carry = findAgentStatusPrefixCarry(tail)
        if (carry.length > 0) {
          cleanData += tail.slice(0, tail.length - carry.length)
          pending = carry
        } else {
          cleanData += tail
        }
        break
      }

      cleanData += combined.slice(cursor, start)
      const payloadStart = start + OSC_AGENT_STATUS_PREFIX.length
      const terminator = findAgentStatusTerminator(combined, payloadStart, nextTerminator)

      if (terminator === null) {
        const candidate = combined.slice(start)
        // Own the frame so it stops pinning the consumed chunk it was sliced from.
        pending = candidate.length > MAX_PENDING ? '' : ownRetainedString(candidate)
        break
      }

      const parsed = parseAgentStatusPayload(combined.slice(payloadStart, terminator.index))
      if (parsed) {
        payloads.push(parsed)
        lastPayloadCleanOffset = cleanData.length
      }
      cursor = terminator.index + terminator.length
    }

    return { cleanData, payloads, lastPayloadCleanOffset }
  }
}
