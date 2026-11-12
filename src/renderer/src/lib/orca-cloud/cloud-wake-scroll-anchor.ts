// REG-13: a scroll made while a cloud pane wakes is kept by the top row's text, not its index. The
// restore rewrites the pane (history, divider, woken screen) and the rows above that line can
// differ in count from the preview the person scrolled, so the same index can land lines away.
import type { RestoreBuffer } from './cloud-wake-scrollback-render'

/** The text of row `y` with trailing blanks dropped, or null when it has none. */
export function wakeAnchorText(
  buffer: Partial<Pick<RestoreBuffer, 'getLine'>>,
  y: number
): string | null {
  const line = buffer.getLine?.(y)
  if (!line) {
    return null
  }
  let text = ''
  for (let x = 0; x < line.length; x++) {
    text += line.getCell(x)?.getChars() || ' '
  }
  text = text.trimEnd()
  return text === '' ? null : text
}

/** The row holding `anchor` nearest to `near`, or `near` when no row holds it. */
export function wakeAnchoredRow(
  buffer: RestoreBuffer,
  anchor: string | null,
  near: number
): number {
  if (anchor === null) {
    return near
  }
  for (let distance = 0; distance < buffer.length; distance++) {
    for (const y of distance === 0 ? [near] : [near - distance, near + distance]) {
      if (y >= 0 && y < buffer.length && wakeAnchorText(buffer, y) === anchor) {
        return y
      }
    }
  }
  return near
}
