// Terminal-output scanning for reply-eliciting query sequences (DSR/CPR,
// DA1/DA2, DECRQM, XTGETTCAP-adjacent CSI queries, OSC 10/11 color probes).
// Shared because both sides must salvage queries out of bytes they are about
// to drop: the renderer's hidden-output restore queue and main's pending-cap
// bulk drop. A swallowed query means the program that sent it waits forever
// for a reply (the bench DSR timeout).
import { parseTerminalOscColorQuery } from './terminal-osc-color-reply'

export const HIDDEN_STARTUP_RENDERER_QUERY_PENDING_CHARS = 64

export type ExtractedRendererQueryData = {
  statelessQueryData: string
  statefulQueryData: string
  oscColorQueryData: string
  pending: string
}

/** Pulls the reply-eliciting queries out of `pending + data`, grouped by how they get answered:
 *  stateless CSI, stateful CSI (CPR, DECRQM) and OSC 10/11 color queries. `pending` returns an
 *  unfinished sequence at the end, to pass back in with the next chunk. */
export function extractHiddenStartupRendererQueryData(
  data: string,
  pending: string
): ExtractedRendererQueryData {
  const input = pending + data
  let statelessQueryData = ''
  let statefulQueryData = ''
  let oscColorQueryData = ''
  let offset = 0

  while (offset < input.length) {
    const candidateIndex = input.indexOf('\x1b', offset)
    if (candidateIndex === -1) {
      break
    }
    if (candidateIndex + 1 >= input.length) {
      return {
        statelessQueryData,
        statefulQueryData,
        oscColorQueryData,
        pending: input.slice(candidateIndex)
      }
    }
    if (input.startsWith('\x1b[', candidateIndex)) {
      const finalByteIndex = findCsiFinalByteIndex(input, candidateIndex + 2)
      if (finalByteIndex === -1) {
        return {
          statelessQueryData,
          statefulQueryData,
          oscColorQueryData,
          pending: input.slice(
            candidateIndex,
            candidateIndex + HIDDEN_STARTUP_RENDERER_QUERY_PENDING_CHARS
          )
        }
      }
      const sequence = input.slice(candidateIndex, finalByteIndex + 1)
      if (isStatelessRendererReplyCsiQuery(sequence)) {
        statelessQueryData += sequence
      } else if (isStatefulRendererReplyCsiQuery(sequence)) {
        statefulQueryData += sequence
      }
      offset = finalByteIndex + 1
      continue
    }

    if (input.startsWith('\x1b]', candidateIndex)) {
      const query = parseTerminalOscColorQuery(input, candidateIndex)
      if (query.kind === 'partial') {
        return {
          statelessQueryData,
          statefulQueryData,
          oscColorQueryData,
          pending: input.slice(
            candidateIndex,
            candidateIndex + HIDDEN_STARTUP_RENDERER_QUERY_PENDING_CHARS
          )
        }
      }
      if (query.kind === 'none') {
        offset = candidateIndex + 2
        continue
      }
      oscColorQueryData += input.slice(candidateIndex, query.endIndex)
      offset = query.endIndex
      continue
    }

    if (parseTerminalOscColorQuery(input, candidateIndex).kind === 'partial') {
      return {
        statelessQueryData,
        statefulQueryData,
        oscColorQueryData,
        pending: input.slice(candidateIndex)
      }
    }

    {
      offset = candidateIndex + 1
      continue
    }
  }

  return { statelessQueryData, statefulQueryData, oscColorQueryData, pending: '' }
}

/** True when `data` holds a complete CSI query the terminal answers, stateless or stateful. A CSI
 *  cut short by the next ESC is skipped, so a query right after it still counts. */
export function containsCsiRendererQuery(data: string): boolean {
  let offset = data.indexOf('\x1b[')
  while (offset !== -1) {
    const finalByteIndex = findCsiFinalByteIndex(data, offset + 2)
    if (finalByteIndex === -1) {
      return false
    }
    const sequence = data.slice(offset, finalByteIndex + 1)
    if (isStatelessRendererReplyCsiQuery(sequence) || isStatefulRendererReplyCsiQuery(sequence)) {
      return true
    }
    offset = data.indexOf('\x1b[', finalByteIndex + 1)
  }
  return false
}

/** True when `data` holds a complete CPR or DECRQM query, whose reply depends on ordered terminal
 *  state. A CSI cut short by the next ESC is skipped, so a query right after it still counts. */
export function containsStatefulRendererQuery(data: string): boolean {
  let offset = data.indexOf('\x1b[')
  while (offset !== -1) {
    const finalByteIndex = findCsiFinalByteIndex(data, offset + 2)
    if (finalByteIndex === -1) {
      return false
    }
    const sequence = data.slice(offset, finalByteIndex + 1)
    if (isStatefulRendererReplyCsiQuery(sequence)) {
      return true
    }
    offset = data.indexOf('\x1b[', finalByteIndex + 1)
  }
  return false
}

/** Last index of the CSI: its final byte, or the byte before an ESC/CAN/SUB that aborts it, as in
 *  xterm's parser, so a carried partial CSI never takes the next sequence's `]` or `[` as its final.
 *  -1 while the sequence is still open. */
export function findCsiFinalByteIndex(data: string, offset: number): number {
  for (let index = offset; index < data.length; index++) {
    const code = data.charCodeAt(index)
    if (code >= 0x40 && code <= 0x7e) {
      return index
    }
    if (code === 0x1b || code === 0x18 || code === 0x1a) {
      return index - 1
    }
  }
  return -1
}

export function isStatelessRendererReplyCsiQuery(sequence: string): boolean {
  if (sequence.endsWith('c')) {
    return true
  }
  return (
    sequence === '\x1b[5n' ||
    sequence === '\x1b[>q' ||
    sequence === '\x1b[14t' ||
    sequence === '\x1b[16t'
  )
}

export function isStatefulRendererReplyCsiQuery(sequence: string): boolean {
  return sequence === '\x1b[6n' || (sequence.startsWith('\x1b[?') && sequence.endsWith('$p'))
}
