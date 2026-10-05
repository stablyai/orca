import { describe, expect, it } from 'vitest'
import { cleanTerminalSelection } from './terminal-selection-gutter'

// Greedy word wrap the way Claude Code's Ink renderer paints a reply: a marker or
// two-space gutter, rows filled up to and including the last column.
function paint(paragraphs: string[], cols: number, marker = '● '): string {
  const rows: string[] = []
  paragraphs.forEach((paragraph, p) => {
    if (p > 0) {
      rows.push('')
    }
    let row = p === 0 ? marker : '  '
    let empty = true
    for (const word of paragraph.split(' ')) {
      if (!empty && row.length + 1 + word.length > cols) {
        rows.push(row)
        row = '  '
        empty = true
      }
      let rest = word
      while (empty && 2 + rest.length > cols) {
        rows.push(row + rest.slice(0, cols - 2))
        rest = rest.slice(cols - 2)
      }
      row += (empty ? '' : ' ') + rest
      empty = false
    }
    rows.push(row)
  })
  return rows.join('\n')
}

const at = (startCol: number, cols: number) => ({ startCol, cols, joinWrappedRows: true })
const inShell = (startCol: number, cols: number) => ({ startCol, cols, joinWrappedRows: false })

const PROSE = [
  'The retry limit is now five and the backoff starts at two seconds instead of half a second, which keeps the queue from flooding the upstream service during an outage.',
  'Second paragraph stays separate, even though it is long enough to wrap over several rows at any of the widths we try here.',
  '• a bullet item that is long enough to wrap onto a continuation row behind the plain gutter',
  'see https://example.com/a/really/long/path/that/does/not/fit/on/one/row/at/all/even/at/eighty/columns/x for details'
]

const CAPTURED_60 = [
  '● Rivers have shaped human civilization for countless',
  '  millennia, serving as vital sources of fresh water,',
  '  crucial transportation routes, and fertile agricultural',
  '  land. From the ancient Nile in Egypt to the mighty Amazon',
  '  in South America, these flowing waterways have nourished',
  '  countless human settlements throughout history and',
  '  continue to be absolutely essential to billions of people',
  '  worldwide today. The ecological importance of rivers',
  '  extends far beyond their service to humans, as they',
  '  support diverse ecosystems and wildlife habitats',
  '  throughout their courses. Rivers provide crucial breeding',
  '  grounds for fish, fresh water for countless animal',
  '  species, and their floodplains create rich biodiversity',
  '  zones that are essential for maintaining the health and',
  "  environmental balance of our planet's natural systems.",
  '',
  '  • Rivers across the world face mounting environmental',
  '  pressures from pollution, damming, and climate change,',
  '  which threaten their ecological health and the survival of',
  '  native species that depend on them for their continued',
  '  existence.',
  '',
  '  • Modern technology has enabled the development of',
  '  large-scale hydroelectric dams that generate renewable',
  '  energy for millions of people, yet these structures',
  '  fundamentally alter river ecosystems, disrupt migration',
  '  patterns for fish species, and change water flow dynamics',
  '  in ways that can have lasting environmental consequences.',
  '',
  '  • Conservation efforts focused on river restoration,',
  '  including the removal of outdated dams, the protection of',
  '  riparian zones, and the implementation of sustainable',
  '  water management practices, are critical for ensuring that',
  '  these vital waterways can continue to support both human',
  '  populations and natural ecosystems for future generations.'
].join('\n')

const CAPTURED_60_TEXT = [
  "Rivers have shaped human civilization for countless millennia, serving as vital sources of fresh water, crucial transportation routes, and fertile agricultural land. From the ancient Nile in Egypt to the mighty Amazon in South America, these flowing waterways have nourished countless human settlements throughout history and continue to be absolutely essential to billions of people worldwide today. The ecological importance of rivers extends far beyond their service to humans, as they support diverse ecosystems and wildlife habitats throughout their courses. Rivers provide crucial breeding grounds for fish, fresh water for countless animal species, and their floodplains create rich biodiversity zones that are essential for maintaining the health and environmental balance of our planet's natural systems.",
  '',
  '• Rivers across the world face mounting environmental pressures from pollution, damming, and climate change, which threaten their ecological health and the survival of native species that depend on them for their continued existence.',
  '',
  '• Modern technology has enabled the development of large-scale hydroelectric dams that generate renewable energy for millions of people, yet these structures fundamentally alter river ecosystems, disrupt migration patterns for fish species, and change water flow dynamics in ways that can have lasting environmental consequences.',
  '',
  '• Conservation efforts focused on river restoration, including the removal of outdated dams, the protection of riparian zones, and the implementation of sustainable water management practices, are critical for ensuring that these vital waterways can continue to support both human populations and natural ecosystems for future generations.'
].join('\n')

describe('cleanTerminalSelection', () => {
  it('restores the paragraphs Claude Code wrapped, at every width', () => {
    const url = PROSE[3].split(' ')[1]
    for (let cols = 30; cols <= 140; cols++) {
      // A token whose last cut piece ends exactly at the edge looks cut mid-token: ambiguous.
      if (url.length >= cols - 2 && url.length % (cols - 2) === 0) {
        continue
      }
      expect(cleanTerminalSelection(paint(PROSE, cols), at(0, cols))).toBe(PROSE.join('\n\n'))
    }
  })

  it('restores a real 60-column capture of Claude Code 2.1', () => {
    expect(cleanTerminalSelection(CAPTURED_60, at(0, 60))).toBe(CAPTURED_60_TEXT)
  })

  it('treats a selection starting mid-line as a partial first row', () => {
    for (let cols = 40; cols <= 120; cols += 7) {
      const fromWord = paint(PROSE.slice(0, 1), cols).slice(2)
      expect(cleanTerminalSelection(fromWord, at(2, cols))).toBe(PROSE[0])
    }
  })

  it('strips the gutter mid-line even when nothing was wrapped', () => {
    const short = ['short answer', '  and a short', '  last line'].join('\n')
    expect(cleanTerminalSelection(short, at(5, 80))).toBe(
      ['short answer', 'and a short', 'last line'].join('\n')
    )
  })

  it('keeps list items and lines the next word would have fitted after apart', () => {
    const lines = ['  Steps:', '  - build it', '  1. run the tests', '  ok then'].join('\n')
    expect(cleanTerminalSelection(lines, at(0, 40))).toBe(
      ['Steps:', '- build it', '1. run the tests', 'ok then'].join('\n')
    )
  })

  it('drops the prompt marker and the padding of an echoed prompt', () => {
    const prompt = [
      '❯ Reply with plain prose only, no lists,',
      '  two sentences.                         '
    ].join('\n')
    expect(cleanTerminalSelection(prompt, at(0, 40))).toBe(
      'Reply with plain prose only, no lists, two sentences.'
    )
  })

  it('leaves tables and plain shell output alone', () => {
    const table = ['  │ name │ value │', '  │ a    │ 1     │'].join('\n')
    expect(cleanTerminalSelection(table, at(0, 18))).toBe(
      ['│ name │ value │', '│ a    │ 1     │'].join('\n')
    )
    const shell = ['drwxr-xr-x 2 user user 4096 Oct  5 file', 'next line of ls output'].join('\n')
    expect(cleanTerminalSelection(shell, at(0, 40))).toBe(shell)
  })

  it('counts wide characters as two cells when deciding a row was wrapped', () => {
    // Nine CJK characters fill the 18 cells after the marker; counted as one cell each they would not.
    const cjk = ['● 漢字漢字漢字漢字漢', '  字漢字'].join('\n')
    expect(cleanTerminalSelection(cjk, at(0, 20))).toBe('漢字漢字漢字漢字漢字漢字')
    const notFull = ['● 漢字漢字', '  字漢字'].join('\n')
    expect(cleanTerminalSelection(notFull, at(0, 20))).toBe(['漢字漢字', '字漢字'].join('\n'))
  })

  it('keeps code fence contents on their own lines', () => {
    const fence = ['● ```ts', '  const foo = 123456', '  return 4', '  ```'].join('\n')
    expect(cleanTerminalSelection(fence, at(0, 20))).toBe(
      ['```ts', 'const foo = 123456', 'return 4', '```'].join('\n')
    )
  })

  it('only trims the gutter of a pane not known to run an agent', () => {
    const indented = ['  123456789012345678', '  status OK'].join('\n')
    expect(cleanTerminalSelection(indented, inShell(0, 20))).toBe(
      ['123456789012345678', 'status OK'].join('\n')
    )
    expect(cleanTerminalSelection(paint([PROSE[0]], 40), inShell(0, 40))).toBe(
      paint([PROSE[0]], 40, '  ')
        .split('\n')
        .map((row) => row.slice(2))
        .join('\n')
    )
  })

  it('drops an empty marker row together with its line break', () => {
    expect(cleanTerminalSelection(['● ', '  Hello'].join('\n'), at(0, 20))).toBe('Hello')
  })

  it('without geometry behaves like the gutter pass', () => {
    const midLine = ['answer starts here', '  and continues'].join('\n')
    expect(cleanTerminalSelection(midLine)).toBe(midLine)
  })
})
