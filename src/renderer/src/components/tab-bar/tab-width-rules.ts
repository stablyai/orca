import type { CSSProperties } from 'react'
import type { TabSizing, TabSizingMode } from '../../../../shared/tab-sizing'

export type TabStripSlotSizing = 'content' | 'terminal'

// Widths come from settings through these vars, so each class string stays static for Tailwind.
const MIN = 'min-w-[var(--tab-min-width)]'
const MAX = 'max-w-[var(--tab-max-width)]'

// Tabs share constrained space down to the min width; terminals reserve room for changing titles.
const AUTO_TERMINAL = `w-[var(--tab-max-width)] ${MAX} ${MIN} flex-auto`
// Cap intrinsic child widths too, so flex shrink starts from the max width even for very long labels.
const AUTO_CONTENT = `w-max ${MAX} ${MIN} flex-initial [&>*]:max-w-[var(--tab-max-width)]`

const CONTAINER_WIDTH_CLASSES: Record<Exclude<TabSizingMode, 'auto'>, string> = {
  // Always as wide as the title; the strip scrolls instead of squeezing tabs.
  fit: `w-max ${MIN} flex-none`,
  // Start at the title width and shrink toward the min width when space runs out.
  shrink: `w-max ${MIN} flex-initial`,
  // The strip is content-sized, so equal widths start at the max and shrink evenly to the min.
  fixed: `w-[var(--tab-max-width)] ${MAX} ${MIN} flex-auto [&>*]:max-w-[var(--tab-max-width)]`
}

export function getTabContainerWidthClasses(
  mode: TabSizingMode,
  sizing: TabStripSlotSizing
): string {
  if (mode === 'auto') {
    return sizing === 'terminal' ? AUTO_TERMINAL : AUTO_CONTENT
  }
  return CONTAINER_WIDTH_CLASSES[mode]
}

type TabWidthVars = CSSProperties & Record<'--tab-min-width' | '--tab-max-width', string>

export function getTabContainerWidthStyle(tabSizing: TabSizing): TabWidthVars {
  return {
    '--tab-min-width': `${tabSizing.minWidth}px`,
    '--tab-max-width': `${tabSizing.maxWidth}px`
  }
}

// Rename reserves a stable editing width without measuring or storing layout in React.
export const TAB_RENAME_WIDTH_CLASSES =
  'has-[[data-tab-rename-input]]:w-[var(--tab-max-width)] has-[[data-tab-rename-input]]:flex-none'

export const TAB_LABEL_WIDTH_CLASSES = 'tab-label min-w-0 flex-1 truncate'
