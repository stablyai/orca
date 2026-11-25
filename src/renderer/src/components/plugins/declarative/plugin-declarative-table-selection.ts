/** How a click, a modified click or Space changes a Table's selection. */
export type PluginDeclarativeSelectionMode = 'none' | 'single' | 'multiple'

export function nextTableSelection(options: {
  mode: PluginDeclarativeSelectionMode
  selected: readonly string[]
  keys: readonly string[]
  key: string
  /** Cmd/Ctrl click or Space: add or remove one row, keeping the rest. */
  toggle: boolean
  /** Shift click: the range from `anchor` to `key`. */
  extend: boolean
  anchor: string | null
}): string[] {
  const { mode, selected, keys, key } = options
  if (mode === 'none') {
    return [...selected]
  }
  if (mode === 'single') {
    return options.toggle && selected.includes(key) ? [] : [key]
  }
  if (options.extend && options.anchor !== null) {
    const from = keys.indexOf(options.anchor)
    const to = keys.indexOf(key)
    if (from !== -1 && to !== -1) {
      return keys.slice(Math.min(from, to), Math.max(from, to) + 1)
    }
  }
  if (options.toggle) {
    return selected.includes(key) ? selected.filter((entry) => entry !== key) : [...selected, key]
  }
  return [key]
}

/** The row index a navigation key moves to, or null when the key does not navigate. */
export function nextTableRow(
  key: string,
  current: number,
  count: number,
  page: number
): number | null {
  if (count === 0) {
    return null
  }
  const moves: Record<string, number> = {
    ArrowDown: current + 1,
    ArrowUp: current - 1,
    Home: 0,
    End: count - 1,
    PageDown: current + page,
    PageUp: current - page
  }
  const next = moves[key]
  return next === undefined ? null : Math.min(count - 1, Math.max(0, next))
}
