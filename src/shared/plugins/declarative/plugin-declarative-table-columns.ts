/** Table widths, in CSS pixels, below which a column with `hideBelow` drops out. */
export const PLUGIN_TABLE_BREAKPOINTS = { sm: 360, md: 480 } as const
export type PluginTableBreakpoint = keyof typeof PLUGIN_TABLE_BREAKPOINTS

/** Smallest a flexible column may get; `auto` keeps the old behaviour (shrinks to nothing). */
export const PLUGIN_TABLE_MIN_WIDTHS = { auto: '0px', xs: '4rem', sm: '6rem', md: '9rem' } as const
export type PluginTableMinWidth = keyof typeof PLUGIN_TABLE_MIN_WIDTHS

type ResponsiveColumn = { key: string; hideBelow?: PluginTableBreakpoint }

/**
 * The columns a table `width` px wide shows: every column whose `hideBelow` breakpoint it reaches.
 * At least one column always stays, so a table never draws empty.
 */
export function pluginTableVisibleColumns<C extends ResponsiveColumn>(
  columns: readonly C[],
  width: number
): C[] {
  const shown = columns.filter(
    (column) => !column.hideBelow || width >= PLUGIN_TABLE_BREAKPOINTS[column.hideBelow]
  )
  return shown.length > 0 ? shown : columns.slice(0, 1)
}
