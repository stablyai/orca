export type TerminalOscColorQueryReplyColors = {
  foreground?: string
  background?: string
}

export type TerminalOscColorQuerySlot = 10 | 11

const OSC = '\u001b]'
const BEL = '\u0007'
const STRING_TERMINATOR = '\u001b\\'
const TERMINAL_OSC_COLOR_QUERY_PREFIXES = [
  { slot: 10, prefix: `${OSC}10;` },
  { slot: 11, prefix: `${OSC}11;` }
] as const
const TERMINAL_OSC_COLOR_QUERY_BODIES = {
  10: [
    { body: '?', slots: [10] },
    { body: '?;?', slots: [10, 11] }
  ],
  11: [{ body: '?', slots: [11] }]
} as const satisfies Record<
  TerminalOscColorQuerySlot,
  readonly { body: string; slots: readonly TerminalOscColorQuerySlot[] }[]
>

export type TerminalOscColorQueryParseResult =
  | { kind: 'match'; slots: readonly TerminalOscColorQuerySlot[]; endIndex: number }
  | { kind: 'partial' }
  | { kind: 'none' }

type TerminalOscTerminatorParseResult =
  | { kind: 'complete'; endIndex: number }
  | { kind: 'partial' }
  | { kind: 'none' }

export function cssColorToOscRgb(value: string | undefined): string | null {
  if (!value) {
    return null
  }
  const trimmed = value.trim()
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(trimmed)?.[1]
  if (hex) {
    const expanded =
      hex.length === 3
        ? hex
            .split('')
            .map((char) => `${char}${char}`)
            .join('')
        : hex
    return `rgb:${byteHexToWord(expanded.slice(0, 2))}/${byteHexToWord(
      expanded.slice(2, 4)
    )}/${byteHexToWord(expanded.slice(4, 6))}`
  }
  const rgb = /^rgba?\(\s*([^)]+)\)$/i.exec(trimmed)
  if (!rgb) {
    return null
  }
  const channels = parseCssRgbChannels(rgb[1])
  if (!channels) {
    return null
  }
  const [red, green, blue] = channels.map((byte) => byte.toString(16).padStart(2, '0').repeat(2))
  return `rgb:${red}/${green}/${blue}`
}

function byteHexToWord(byte: string): string {
  return byte.repeat(2)
}

function parseCssRgbChannels(body: string): [number, number, number] | null {
  const colorPart = body.split('/')[0]?.trim()
  if (!colorPart) {
    return null
  }
  const components = colorPart.includes(',')
    ? colorPart.split(',').slice(0, 3)
    : colorPart.split(/\s+/).slice(0, 3)
  if (components.length !== 3) {
    return null
  }
  const channels = components.map((component) => parseCssRgbChannel(component.trim()))
  if (channels.some((channel) => channel === null)) {
    return null
  }
  return channels as [number, number, number]
}

function parseCssRgbChannel(component: string): number | null {
  const percent = /^(\d+(?:\.\d+)?)%$/.exec(component)?.[1]
  if (percent !== undefined) {
    return clampByte((Number(percent) / 100) * 255)
  }
  if (!/^\d+(?:\.\d+)?$/.test(component)) {
    return null
  }
  return clampByte(Number(component))
}

function clampByte(value: number): number {
  return Math.min(255, Math.max(0, Math.round(value)))
}

export function terminalOscColorQueryReply(
  colors: TerminalOscColorQueryReplyColors,
  slot: TerminalOscColorQuerySlot
): string | null {
  const color =
    slot === 10 ? cssColorToOscRgb(colors.foreground) : cssColorToOscRgb(colors.background)
  if (!color) {
    return null
  }
  return `\x1b]${slot};${color}\x1b\\`
}

function isTerminalOscColorQueryReply(reply: string | null): reply is string {
  return reply !== null
}

export function terminalOscColorQueryReplies(
  colors: TerminalOscColorQueryReplyColors,
  slots: readonly TerminalOscColorQuerySlot[]
): string[] | null {
  const replies = slots.map((slot) => terminalOscColorQueryReply(colors, slot))
  return replies.every(isTerminalOscColorQueryReply) ? replies : null
}

export function terminalOscColorQuerySlotsForBody(
  slot: TerminalOscColorQuerySlot,
  body: string
): readonly TerminalOscColorQuerySlot[] | null {
  return TERMINAL_OSC_COLOR_QUERY_BODIES[slot].find((entry) => entry.body === body)?.slots ?? null
}

function parseTerminalOscTerminator(
  data: string,
  offset: number
): TerminalOscTerminatorParseResult {
  if (offset >= data.length) {
    return { kind: 'partial' }
  }
  if (data[offset] === BEL) {
    return { kind: 'complete', endIndex: offset + BEL.length }
  }
  if (data.startsWith(STRING_TERMINATOR, offset)) {
    return { kind: 'complete', endIndex: offset + STRING_TERMINATOR.length }
  }
  if (data[offset] === '\x1b' && offset + 1 >= data.length) {
    // Why: streamed PTY chunks can split the ST terminator between ESC and \\.
    return { kind: 'partial' }
  }
  return { kind: 'none' }
}

function completeTerminalOscColorQuery(
  slot: TerminalOscColorQuerySlot,
  body: string,
  terminator: TerminalOscTerminatorParseResult
): TerminalOscColorQueryParseResult {
  if (terminator.kind !== 'complete') {
    return terminator
  }
  const slots = terminalOscColorQuerySlotsForBody(slot, body)
  return slots ? { kind: 'match', slots, endIndex: terminator.endIndex } : { kind: 'none' }
}

function parseTerminalOscColorQueryBody(
  data: string,
  bodyStart: number,
  slot: TerminalOscColorQuerySlot
): TerminalOscColorQueryParseResult {
  if (bodyStart >= data.length) {
    return { kind: 'partial' }
  }
  if (data[bodyStart] !== '?') {
    return { kind: 'none' }
  }
  const singleQueryTerminator = parseTerminalOscTerminator(data, bodyStart + 1)
  if (singleQueryTerminator.kind !== 'none') {
    return completeTerminalOscColorQuery(slot, '?', singleQueryTerminator)
  }
  if (slot !== 10 || data[bodyStart + 1] !== ';') {
    return { kind: 'none' }
  }
  if (bodyStart + 2 >= data.length) {
    return { kind: 'partial' }
  }
  if (data[bodyStart + 2] !== '?') {
    return { kind: 'none' }
  }
  return completeTerminalOscColorQuery(slot, '?;?', parseTerminalOscTerminator(data, bodyStart + 3))
}

export function parseTerminalOscColorQuery(
  data: string,
  offset: number
): TerminalOscColorQueryParseResult {
  const entry = TERMINAL_OSC_COLOR_QUERY_PREFIXES.find(({ prefix }) =>
    data.startsWith(prefix, offset)
  )
  if (!entry) {
    const fragment = data.slice(offset)
    return TERMINAL_OSC_COLOR_QUERY_PREFIXES.some(({ prefix }) => prefix.startsWith(fragment))
      ? { kind: 'partial' }
      : { kind: 'none' }
  }
  const bodyStart = offset + entry.prefix.length
  return parseTerminalOscColorQueryBody(data, bodyStart, entry.slot)
}

export function sendTerminalOscColorQueryReplies(
  data: string,
  colors: TerminalOscColorQueryReplyColors,
  sendInput: (data: string) => boolean | void
): boolean {
  let sent = false
  let offset = 0
  while (offset < data.length) {
    const oscIndex = data.indexOf(OSC, offset)
    if (oscIndex === -1) {
      break
    }
    const query = parseTerminalOscColorQuery(data, oscIndex)
    if (query.kind === 'match') {
      const replies = terminalOscColorQueryReplies(colors, query.slots)
      if (replies) {
        for (const reply of replies) {
          sendInput(reply)
        }
        sent = true
      }
      offset = query.endIndex
      continue
    }
    if (query.kind === 'partial') {
      break
    }
    offset = oscIndex + OSC.length
  }
  return sent
}
