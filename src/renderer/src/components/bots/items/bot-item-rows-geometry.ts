// A row window's geometry: where each shown row sits, from the two row heights (one line, or two with a
// chat line) read from drawn rows.

/** A one-line row and its gap, and one that names its chat on a second line. Until a drawn row is
 *  read, their heights at the default font size; a larger font (Orca Web) makes them taller. */
export type RowSizes = { row: number; placed: number }
export const DEFAULT_ROW_SIZES: RowSizes = { row: 30, placed: 46 }

export type Geometry = {
  total: number
  offset: (index: number) => number
  height: (index: number) => number
  /** The row at `y` px into the group, clamped to the rows. */
  indexAt: (y: number) => number
}

export function uniformGeometry(count: number, { row }: RowSizes): Geometry {
  return {
    total: count * row,
    offset: (index) => index * row,
    height: () => row,
    indexAt: (y) => Math.min(Math.max(0, count - 1), Math.max(0, Math.floor(y / row)))
  }
}

export function mixedGeometry(tall: readonly boolean[], sizes: RowSizes): Geometry {
  const offsets = [0]
  for (const placed of tall) {
    offsets.push(offsets.at(-1)! + (placed ? sizes.placed : sizes.row))
  }
  return {
    total: offsets.at(-1)!,
    offset: (index) => offsets[index] ?? 0,
    height: (index) => (offsets[index + 1] ?? 0) - (offsets[index] ?? 0),
    indexAt: (y) => {
      let low = 0
      let high = tall.length - 1
      while (low < high) {
        const middle = (low + high + 1) >> 1
        if (offsets[middle]! <= y) {
          low = middle
        } else {
          high = middle - 1
        }
      }
      return Math.max(0, low)
    }
  }
}

/** Which row kinds' heights have been read from a drawn row. */
export type RowSizesKnown = { row: boolean; placed: boolean }
export const NO_ROW_SIZES_KNOWN: RowSizesKnown = { row: false, placed: false }

/** Which kinds of row the drawn rows `start`..`end` include, from the rows' chat-line flags ('' when no
 *  row can have one): known without reading the page. */
function drawnRowKinds(tallKey: string, start: number, end: number): RowSizesKnown {
  if (tallKey === '') {
    return { row: end > start, placed: false }
  }
  const drawn = tallKey.slice(start, end)
  return { row: drawn.includes('0'), placed: drawn.includes('1') }
}

/** The heights of the kinds still unknown that the drawn rows (`range`) include, read as laid out;
 *  `was` for the rest. */
export function readMissingRowSizes(
  container: HTMLElement,
  was: RowSizes,
  known: RowSizesKnown,
  tallKey: string,
  range: { start: number; end: number }
): { sizes: RowSizes; known: RowSizesKnown } {
  const drawn = drawnRowKinds(tallKey, range.start, range.end)
  const heightOf = (wanted: boolean, selector: string): number =>
    (wanted && container.querySelector(selector)?.getBoundingClientRect().height) || 0
  const rowRead = heightOf(
    drawn.row && !known.row,
    ':scope > [data-bot-item-row]:not([data-bot-item-tall])'
  )
  const placedRead = heightOf(
    drawn.placed && !known.placed,
    ':scope > [data-bot-item-row][data-bot-item-tall]'
  )
  if (!rowRead && !placedRead) {
    return { sizes: was, known }
  }
  const row = rowRead || was.row
  const placed = placedRead || was.placed
  return {
    sizes: row === was.row && placed === was.placed ? was : { row, placed },
    known: { row: known.row || rowRead > 0, placed: known.placed || placedRead > 0 }
  }
}
