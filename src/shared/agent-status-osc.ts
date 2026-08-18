import type { ParsedAgentStatusPayload } from './agent-status-types'
import { parseAgentStatusOscFrame } from './agent-status-osc-frame'
import type { AgentStatusOscNonceEnforcement, AgentStatusOscTrust } from './agent-status-osc-nonce'
import {
  DEFAULT_AGENT_STATUS_OSC_NONCE_ENFORCEMENT,
  gradeAgentStatusOscNonce
} from './agent-status-osc-nonce'

const OSC_AGENT_STATUS_PREFIX = '\x1b]9999;'

export type AttestedAgentStatusPayload = {
  payload: ParsedAgentStatusPayload
  trust: AgentStatusOscTrust
}

/**
 * Nonce-gate outcome for one chunk. In-process only — it is never persisted,
 * sent over IPC, or published to paired clients.
 */
export type AgentStatusOscChunkAttestation = {
  /** Index-aligned with `payloads`. */
  accepted: AttestedAgentStatusPayload[]
  /** Well-formed payloads the gate refused (wrong nonce, or unattested while enforcing). */
  rejected: number
}

export type ProcessedAgentStatusChunk = {
  cleanData: string
  /** Payloads that passed the gate, in byte order. */
  payloads: ParsedAgentStatusPayload[]
  /** Offset into `cleanData` of the last payload the gate accepted. */
  lastPayloadCleanOffset: number | null
  attestation: AgentStatusOscChunkAttestation
}

export type AgentStatusOscProcessorOptions = {
  /**
   * The pane's nonce, read late so a processor created before the PTY's env is
   * recorded still gates correctly. Null/absent means the pane was never
   * stamped, and every payload is accepted as `pane-unstamped`.
   */
  getExpectedNonce?: () => string | null
  enforcement?: AgentStatusOscNonceEnforcement
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
export function createAgentStatusOscProcessor(
  options: AgentStatusOscProcessorOptions = {}
): (data: string) => ProcessedAgentStatusChunk {
  const MAX_PENDING = 64 * 1024
  const enforcement = options.enforcement ?? DEFAULT_AGENT_STATUS_OSC_NONCE_ENFORCEMENT
  let pending = ''

  return (data: string): ProcessedAgentStatusChunk => {
    const combined = pending + data
    pending = ''

    const payloads: ParsedAgentStatusPayload[] = []
    let lastPayloadCleanOffset: number | null = null
    const accepted: AttestedAgentStatusPayload[] = []
    let rejected = 0
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
          pending = tail.slice(tail.length - partialPrefixLen)
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

      const frame = parseAgentStatusOscFrame(combined.slice(payloadStart, terminator.index))
      if (frame) {
        const verdict = gradeAgentStatusOscNonce({
          presented: frame.nonce,
          expected: options.getExpectedNonce?.() ?? null,
          enforcement
        })
        if (verdict.accepted) {
          payloads.push(frame.payload)
          accepted.push({ payload: frame.payload, trust: verdict.trust })
          // Stays aligned with `payloads`: a rejected payload emits no status
          // event, so prompt-lifecycle byte order must not anchor to it.
          lastPayloadCleanOffset = cleanData.length
        } else {
          rejected += 1
        }
      }
      cursor = terminator.index + terminator.length
    }

    // The OSC bytes are stripped from cleanData whether or not the gate accepted
    // the payload: a rejected sequence must not be re-rendered into the pane.
    return { cleanData, payloads, lastPayloadCleanOffset, attestation: { accepted, rejected } }
  }
}
