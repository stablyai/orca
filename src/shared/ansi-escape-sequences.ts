/* eslint-disable no-control-regex -- these patterns exist to match terminal control bytes. */
import { ownRetainedString } from './own-retained-string'

/** CSI sequences (colors, cursor moves, `\u001b[0K` erase-to-EOL). */
export const CSI_SEQUENCE_PATTERN = /(?:\u001b\[|\u009b)[0-?]*[ -/]*[@-~]/g
/** Remaining two/three-byte escape sequences (charset selection, RIS, ...). */
export const ESCAPE_SEQUENCE_PATTERN = /\u001b[ -/]*[0-~]/g
/** C0/C1 control bytes except tab, line feed and carriage return. */
export const TERMINAL_CONTROL_CHARACTER_PATTERN =
  /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g

type TerminatorSearch = { cursor: number; start: number; end: number }
const OSC_INTRODUCER_PATTERN = /\u001b\]|\u009d/
const STRING_INTRODUCER_PATTERN = /\u001b[P_^X]|[\u0090\u0098\u009e\u009f]/
const CONTROL_STRING_INTRODUCER_PATTERN = /\u001b[\]P_^X]|[\u0090\u0098\u009d-\u009f]/
/** Any byte that can introduce an ANSI escape or control string. */
export const ANSI_INTRODUCER_PATTERN = /[\u001b\u0090\u0098\u009b\u009d-\u009f]/

function nextSt(value: string, payloadStart: number, search: TerminatorSearch): void {
  if (search.start >= payloadStart || search.cursor === value.length) {
    return
  }
  for (let index = Math.max(search.cursor, payloadStart); index < value.length; index += 1) {
    const unit = value.charCodeAt(index)
    const width = unit === 0x9c ? 1 : unit === 0x1b && value.charCodeAt(index + 1) === 0x5c ? 2 : 0
    if (width) {
      search.start = index
      search.end = index + width
      search.cursor = search.end
      return
    }
  }
  search.start = -1
  search.cursor = value.length
}

function createAnsiSpanCollector(value: string) {
  let block = ''
  const blocks: string[] = []
  const appendSpan = (start: number, end: number): void => {
    while (start < end) {
      const next = Math.min(end, start + 4096 - block.length)
      block += value.slice(start, next)
      start = next
      if (block.length === 4096) {
        blocks.push(ownRetainedString(block))
        block = ''
      }
    }
  }
  return {
    appendSpan,
    finish: (): string => {
      if (block) {
        blocks.push(ownRetainedString(block))
      }
      return blocks.join('')
    }
  }
}

function stripControlStrings(value: string, osc: boolean): string {
  if (!(osc ? OSC_INTRODUCER_PATTERN : STRING_INTRODUCER_PATTERN).test(value)) {
    return value
  }
  const st: TerminatorSearch = { cursor: 0, start: -1, end: 0 }
  let bel = -1
  let belExhausted = false
  let spanStart = 0
  let collector: ReturnType<typeof createAnsiSpanCollector> | undefined
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index)
    let width = 0
    if (unit === 0x1b) {
      const next = value.charCodeAt(index + 1)
      if (osc ? next === 0x5d : next === 0x50 || next === 0x5f || next === 0x5e || next === 0x58) {
        width = 2
      }
    } else if (
      osc ? unit === 0x9d : unit === 0x90 || unit === 0x98 || unit === 0x9e || unit === 0x9f
    ) {
      width = 1
    }
    if (!width) {
      continue
    }
    const payloadStart = index + width
    nextSt(value, payloadStart, st)
    if (osc && bel < payloadStart && !belExhausted) {
      bel = value.indexOf('\u0007', payloadStart)
      belExhausted = bel === -1
    }
    const useBel = osc && bel >= payloadStart && (st.start < payloadStart || bel < st.start)
    const end = useBel ? bel + 1 : st.start >= payloadStart ? st.end : -1
    if (end === -1) {
      continue
    }
    collector ??= createAnsiSpanCollector(value)
    collector.appendSpan(spanStart, index)
    spanStart = end
    index = end - 1
  }
  if (!collector) {
    return value
  }
  collector.appendSpan(spanStart, value.length)
  return collector.finish()
}

function stripGenericEscapes(value: string): string {
  let index = value.indexOf('\u001b')
  let spanStart = 0
  let collector: ReturnType<typeof createAnsiSpanCollector> | undefined
  // Dense unfinished 7-bit strings must not allocate a global replacement entry per introducer.
  while (index !== -1) {
    let end = index + 1
    let unit = value.charCodeAt(end)
    while (unit >= 0x20 && unit <= 0x2f) {
      end += 1
      unit = value.charCodeAt(end)
    }
    if (unit >= 0x30 && unit <= 0x7e) {
      collector ??= createAnsiSpanCollector(value)
      collector.appendSpan(spanStart, index)
      end += 1
      spanStart = end
    }
    index = value.indexOf('\u001b', end)
  }
  if (!collector) {
    return value
  }
  collector.appendSpan(spanStart, value.length)
  return collector.finish()
}

/** Consume OSC/string sequences before generic escapes or only introducers disappear; preserve text, tabs and line breaks. */
export function stripAnsiEscapeSequences(value: string): string {
  if (!ANSI_INTRODUCER_PATTERN.test(value)) {
    return value
  }
  const stripped = CONTROL_STRING_INTRODUCER_PATTERN.test(value)
    ? stripControlStrings(stripControlStrings(value, true), false)
    : value
  const withoutCsi = stripped.replace(CSI_SEQUENCE_PATTERN, '')
  return stripGenericEscapes(withoutCsi)
}
