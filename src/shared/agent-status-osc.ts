import type { ParsedAgentStatusPayload } from './agent-status-types'
import { parseAgentStatusPayload } from './agent-status-types'
import { detachString, EMPTY_DETACHED_STRING, type DetachedString } from './detached-string'

const OSC_AGENT_STATUS_PREFIX = '\x1b]9999;'

export type ProcessedAgentStatusChunk = {
  cleanData: string
  payloads: ParsedAgentStatusPayload[]
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
  let pending: DetachedString = EMPTY_DETACHED_STRING

  return (data: string): ProcessedAgentStatusChunk => {
    const combined = pending + data
    pending = EMPTY_DETACHED_STRING

    const payloads: ParsedAgentStatusPayload[] = []
    let cleanData = ''
    let cursor = 0

    while (cursor < combined.length) {
      const start = combined.indexOf(OSC_AGENT_STATUS_PREFIX, cursor)
      if (start === -1) {
        const tail = combined.slice(cursor)
        const prefixLen = OSC_AGENT_STATUS_PREFIX.length
        let partialPrefixLen = 0
        for (let k = Math.min(prefixLen - 1, tail.length); k > 0; k--) {
          if (tail.endsWith(OSC_AGENT_STATUS_PREFIX.slice(0, k))) {
            partialPrefixLen = k
            break
          }
        }
        if (partialPrefixLen > 0) {
          cleanData += tail.slice(0, tail.length - partialPrefixLen)
          pending = detachString(tail.slice(tail.length - partialPrefixLen))
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
        // Persisted per-pane payloads must not retain their source PTY chunks.
        pending = candidate.length > MAX_PENDING ? EMPTY_DETACHED_STRING : detachString(candidate)
        break
      }

      const parsed = parseAgentStatusPayload(combined.slice(payloadStart, terminator.index))
      if (parsed) {
        payloads.push(parsed)
      }
      cursor = terminator.index + terminator.length
    }

    return { cleanData, payloads }
  }
}
