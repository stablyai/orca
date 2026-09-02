import type { ParsedAgentStatusPayload } from './agent-status-types'
import { parseAgentStatusPayload } from './agent-status-types'

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
  searchFrom: number
): { index: number; length: 1 | 2 } | null {
  const belIndex = data.indexOf('\x07', searchFrom)
  const stIndex = data.indexOf('\x1b\\', searchFrom)
  if (belIndex === -1 && stIndex === -1) {
    return null
  }
  if (belIndex === -1) {
    return { index: stIndex, length: 2 }
  }
  if (stIndex === -1 || belIndex < stIndex) {
    return { index: belIndex, length: 1 }
  }
  return { index: stIndex, length: 2 }
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
      const terminator = findAgentStatusTerminator(combined, payloadStart)

      if (terminator === null) {
        const candidate = combined.slice(start)
        pending = candidate.length > MAX_PENDING ? '' : candidate
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
