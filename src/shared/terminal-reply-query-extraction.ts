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

export function findCsiFinalByteIndex(data: string, offset: number): number {
  for (let index = offset; index < data.length; index++) {
    const code = data.charCodeAt(index)
    if (code >= 0x40 && code <= 0x7e) {
      return index
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
