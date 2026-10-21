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
  let statelessQueryData = ''
  let statefulQueryData = ''
  let oscColorQueryData = ''
  const nextPending = visitRendererReplyQueries(data, pending, (input, start, end, kind) => {
    const sequence = input.slice(start, end)
    if (kind === 'stateless') {
      statelessQueryData += sequence
    } else if (kind === 'stateful') {
      statefulQueryData += sequence
    } else {
      oscColorQueryData += sequence
    }
    return true
  })
  return { statelessQueryData, statefulQueryData, oscColorQueryData, pending: nextPending }
}

/** Complete queries in source order, bounded before copying any retained sequence. */
export function extractOrderedRendererQueryData(
  data: string,
  maxChars: number,
  endAt = data.length,
  accept: (chars: number) => boolean = () => true
): string {
  let result = ''
  visitRendererReplyQueries(data, '', (input, start, end) => {
    if (end > endAt || end - start > maxChars - result.length || !accept(end - start)) {
      return false
    }
    result += input.slice(start, end)
    return true
  })
  return result
}

type RendererQueryKind = 'stateless' | 'stateful' | 'oscColor'

function rendererQueryKind(input: string, start: number, end: number): RendererQueryKind | null {
  if (input[end - 1] === 'c') {
    return 'stateless'
  }
  if (input.startsWith('\x1b[?', start) && input[end - 2] === '$' && input[end - 1] === 'p') {
    return 'stateful'
  }
  if (end - start > 6) {
    return null
  }
  const sequence = input.slice(start, end)
  if (isStatelessRendererReplyCsiQuery(sequence)) {
    return 'stateless'
  }
  return isStatefulRendererReplyCsiQuery(sequence) ? 'stateful' : null
}

function visitRendererReplyQueries(
  data: string,
  pending: string,
  emit: (input: string, start: number, end: number, kind: RendererQueryKind) => boolean
): string {
  const input = pending ? pending + data : data
  let offset = 0

  while (offset < input.length) {
    const candidateIndex = input.indexOf('\x1b', offset)
    if (candidateIndex === -1) {
      break
    }
    if (candidateIndex + 1 >= input.length) {
      return input.slice(candidateIndex)
    }
    if (input.startsWith('\x1b[', candidateIndex)) {
      const finalByteIndex = findCsiFinalByteIndex(input, candidateIndex + 2)
      if (finalByteIndex === -1) {
        return input.slice(
          candidateIndex,
          candidateIndex + HIDDEN_STARTUP_RENDERER_QUERY_PENDING_CHARS
        )
      }
      const end = finalByteIndex + 1
      // Inspect endpoints before copying: a bounded sink must never materialize an oversized query.
      const kind = rendererQueryKind(input, candidateIndex, end)
      if (kind && !emit(input, candidateIndex, end, kind)) {
        return ''
      }
      offset = finalByteIndex + 1
      continue
    }

    if (input.startsWith('\x1b]', candidateIndex)) {
      const query = parseTerminalOscColorQuery(input, candidateIndex)
      if (query.kind === 'partial') {
        return input.slice(
          candidateIndex,
          candidateIndex + HIDDEN_STARTUP_RENDERER_QUERY_PENDING_CHARS
        )
      }
      if (query.kind === 'none') {
        offset = candidateIndex + 2
        continue
      }
      if (!emit(input, candidateIndex, query.endIndex, 'oscColor')) {
        return ''
      }
      offset = query.endIndex
      continue
    }

    if (parseTerminalOscColorQuery(input, candidateIndex).kind === 'partial') {
      return input.slice(candidateIndex)
    }

    {
      offset = candidateIndex + 1
      continue
    }
  }

  return ''
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
