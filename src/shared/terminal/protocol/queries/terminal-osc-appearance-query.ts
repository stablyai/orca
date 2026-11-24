import { findOscTerminatorStart, parseTerminalOscTerminator } from './terminal-osc-color-reply'

export type TerminalOscSpecialColorSlot = 'foreground' | 'background' | 'cursor'

/** One `slot;spec` of an OSC 4 or 10/11/12 body; `?` queries the slot, anything else sets it. */
export type TerminalOscAppearanceEntry =
  | { kind: 'palette'; index: number; spec: string }
  | { kind: 'special'; slot: TerminalOscSpecialColorSlot; spec: string }

export type TerminalOscAppearanceQueryParseResult =
  | { kind: 'appearance'; entries: readonly TerminalOscAppearanceEntry[]; endIndex: number }
  | { kind: 'partial' }
  | { kind: 'none' }

const OSC = '\x1b]'
const PALETTE_PREFIX = `${OSC}4;`
// OSC 10/11/12 stack extra params onto the following slots, as xterm does: `OSC 10;?;?;?`.
const SPECIAL_PREFIXES: readonly {
  prefix: string
  slots: readonly TerminalOscSpecialColorSlot[]
}[] = [
  { prefix: `${OSC}10;`, slots: ['foreground', 'background', 'cursor'] },
  { prefix: `${OSC}11;`, slots: ['background', 'cursor'] },
  { prefix: `${OSC}12;`, slots: ['cursor'] }
]
const PREFIXES = [PALETTE_PREFIX, ...SPECIAL_PREFIXES.map(({ prefix }) => prefix)]
const PALETTE_SIZE = 256

/** Room for an OSC 4 SET of every palette slot (`255;rgb:ffff/ffff/ffff;` each). */
export const MAX_APPEARANCE_OSC_BODY_CHARS = PALETTE_SIZE * 32

export const SPECIAL_COLOR_IDENTS: Record<TerminalOscSpecialColorSlot, string> = {
  foreground: '10',
  background: '11',
  cursor: '12'
}

/** OSC 4/10/11/12 with at least one query, read as the headless responder reads them: invalid palette indexes and
 *  params past the last stacked slot are dropped. A launcher-pinned owner answers these for the viewers. */
export function parseTerminalOscAppearanceQuery(
  data: string,
  offset: number
): TerminalOscAppearanceQueryParseResult {
  const prefix = PREFIXES.find((candidate) => data.startsWith(candidate, offset))
  if (!prefix) {
    const fragment = data.slice(offset)
    return PREFIXES.some((candidate) => candidate.startsWith(fragment))
      ? { kind: 'partial' }
      : { kind: 'none' }
  }
  const bodyStart = offset + prefix.length
  const bodyEnd = findOscTerminatorStart(data, bodyStart)
  if (bodyEnd === -1) {
    return data.length - bodyStart <= MAX_APPEARANCE_OSC_BODY_CHARS
      ? { kind: 'partial' }
      : { kind: 'none' }
  }
  const terminator = parseTerminalOscTerminator(data, bodyEnd)
  if (bodyEnd - bodyStart > MAX_APPEARANCE_OSC_BODY_CHARS || terminator.kind !== 'complete') {
    return terminator.kind === 'partial' ? terminator : { kind: 'none' }
  }
  const params = data.slice(bodyStart, bodyEnd).split(';')
  const special = SPECIAL_PREFIXES.find((entry) => entry.prefix === prefix)
  const entries = special
    ? params
        .slice(0, special.slots.length)
        .map((spec, index) => ({ kind: 'special' as const, slot: special.slots[index], spec }))
    : paletteEntries(params)
  return entries.some((entry) => entry.spec === '?')
    ? { kind: 'appearance', entries, endIndex: terminator.endIndex }
    : { kind: 'none' }
}

/** The SETs of an owned sequence, for the viewers to paint with; its queries are the owner's to answer. */
export function terminalOscAppearanceSets(entries: readonly TerminalOscAppearanceEntry[]): string {
  const sets = entries.filter((entry) => entry.spec !== '?')
  const palette = sets.flatMap((entry) =>
    entry.kind === 'palette' ? [`${entry.index};${entry.spec}`] : []
  )
  return [
    ...(palette.length > 0 ? [`${OSC}4;${palette.join(';')}\x1b\\`] : []),
    ...sets.flatMap((entry) =>
      entry.kind === 'special'
        ? [`${OSC}${SPECIAL_COLOR_IDENTS[entry.slot]};${entry.spec}\x1b\\`]
        : []
    )
  ].join('')
}

function paletteEntries(params: readonly string[]): TerminalOscAppearanceEntry[] {
  const entries: TerminalOscAppearanceEntry[] = []
  for (let i = 0; i + 1 < params.length; i += 2) {
    const index = /^\d+$/.test(params[i]) ? Number.parseInt(params[i], 10) : PALETTE_SIZE
    if (index < PALETTE_SIZE) {
      entries.push({ kind: 'palette', index, spec: params[i + 1] })
    }
  }
  return entries
}
