/**
 * Pierre tags each rendered row with `data-line`, so a line scroll is a lookup
 * inside the shadow root. Virtualized rows may not exist yet, hence the
 * proportional fallback: land close, then let the caller retry once painted.
 */
export function scrollPierreDiffToLine({
  host,
  container,
  lineNumber,
  hunkIndex,
  hunkCount
}: {
  host: HTMLElement | null
  container: HTMLElement | null
  lineNumber: number
  hunkIndex: number
  hunkCount: number
}): boolean {
  if (!container) {
    return false
  }
  const row = host?.shadowRoot?.querySelector(`[data-line="${lineNumber}"]`)
  if (row instanceof HTMLElement) {
    const offset = row.getBoundingClientRect().top - container.getBoundingClientRect().top
    container.scrollTop += offset - container.clientHeight / 3
    return true
  }
  if (hunkCount > 0) {
    container.scrollTop = (hunkIndex / hunkCount) * container.scrollHeight
  }
  return false
}
