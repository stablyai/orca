import { findCsiFinalByteIndex } from './terminal-reply-query-extraction'
import { parseTerminalOscColorQuery } from './terminal-osc-color-reply'

const ESC = '\x1b'
const MAX_PENDING_QUERY_CHARS = 4096
/* oxlint-disable no-control-regex -- terminal query grammars contain ESC by definition */
const DEVICE_ATTRIBUTES_QUERY_RE = new RegExp('^\\u001b\\[[?>=]?[0-9;]*c$')
const MODE_QUERY_RE = new RegExp('^\\u001b\\[\\??[0-9;]+\\$p$')
/* oxlint-enable no-control-regex */

export type TerminalReplyQuerySequence = {
  data: string
  startSeq: number
  endSeq: number
}

export type TerminalReplyQueryScanState = {
  pending: string
  pendingStartSeq: number | null
}

export const EMPTY_TERMINAL_REPLY_QUERY_SCAN_STATE: TerminalReplyQueryScanState = {
  pending: '',
  pendingStartSeq: null
}

function isReplyElicitingCsi(sequence: string): boolean {
  if (DEVICE_ATTRIBUTES_QUERY_RE.test(sequence)) {
    return true
  }
  if (MODE_QUERY_RE.test(sequence)) {
    return true
  }
  return (
    sequence === '\x1b[5n' ||
    sequence === '\x1b[6n' ||
    sequence === '\x1b[?6n' ||
    sequence === '\x1b[?996n' ||
    sequence === '\x1b[>q' ||
    sequence === '\x1b[14t' ||
    sequence === '\x1b[16t' ||
    sequence === '\x1b[18t' ||
    sequence === '\x1b[?u' ||
    sequence === '\x1b[?2031h'
  )
}

function boundedPending(input: string, startIndex: number): string {
  return input.slice(startIndex, startIndex + MAX_PENDING_QUERY_CHARS)
}

export function scanTerminalReplyQuerySequences(
  data: string,
  chunkStartSeq: number,
  previous: TerminalReplyQueryScanState
): { queries: TerminalReplyQuerySequence[]; state: TerminalReplyQueryScanState } {
  const continuesPending =
    previous.pendingStartSeq !== null &&
    previous.pendingStartSeq + previous.pending.length === chunkStartSeq
  const pending = continuesPending ? previous.pending : ''
  const input = pending + data
  const inputStartSeq = chunkStartSeq - pending.length
  const queries: TerminalReplyQuerySequence[] = []
  let offset = 0

  while (offset < input.length) {
    const candidateIndex = input.indexOf(ESC, offset)
    if (candidateIndex === -1) {
      break
    }
    if (candidateIndex + 1 >= input.length) {
      const nextPending = boundedPending(input, candidateIndex)
      return {
        queries,
        state: { pending: nextPending, pendingStartSeq: inputStartSeq + candidateIndex }
      }
    }

    let endIndex = -1
    let matches = false
    if (input.startsWith(`${ESC}[`, candidateIndex)) {
      endIndex = findCsiFinalByteIndex(input, candidateIndex + 2)
      if (endIndex !== -1) {
        matches = isReplyElicitingCsi(input.slice(candidateIndex, endIndex + 1))
      }
    } else if (input.startsWith(`${ESC}]`, candidateIndex)) {
      const osc = parseTerminalOscColorQuery(input, candidateIndex)
      if (osc.kind === 'partial') {
        endIndex = -1
      } else if (osc.kind === 'match') {
        endIndex = osc.endIndex - 1
        matches = true
      } else {
        endIndex = candidateIndex + 1
      }
    } else if (input.startsWith(`${ESC}P`, candidateIndex)) {
      const terminatorIndex = input.indexOf(`${ESC}\\`, candidateIndex + 2)
      if (terminatorIndex !== -1) {
        endIndex = terminatorIndex + 1
        const body = input.slice(candidateIndex + 2, terminatorIndex)
        matches = body.startsWith('$q') || body.startsWith('+q')
      }
    } else {
      endIndex = candidateIndex
    }

    if (endIndex === -1) {
      const nextPending = boundedPending(input, candidateIndex)
      return {
        queries,
        state: { pending: nextPending, pendingStartSeq: inputStartSeq + candidateIndex }
      }
    }
    if (matches) {
      queries.push({
        data: input.slice(candidateIndex, endIndex + 1),
        startSeq: inputStartSeq + candidateIndex,
        endSeq: inputStartSeq + endIndex + 1
      })
    }
    offset = endIndex + 1
  }

  return { queries, state: EMPTY_TERMINAL_REPLY_QUERY_SCAN_STATE }
}
