export const BROWSER_TAB_SPLIT_DIRECTIONS = ['right', 'left', 'down', 'up'] as const
export type BrowserTabSplitDirection = (typeof BROWSER_TAB_SPLIT_DIRECTIONS)[number]

export function isBrowserTabSplitDirection(value: string): value is BrowserTabSplitDirection {
  return BROWSER_TAB_SPLIT_DIRECTIONS.some((direction) => direction === value)
}
