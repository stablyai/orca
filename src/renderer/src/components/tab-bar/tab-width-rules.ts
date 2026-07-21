import {
  DEFAULT_TERMINAL_TAB_WIDTH,
  type TerminalTabWidth
} from '../../../../shared/terminal-tab-width'

// Why: tab strips should reveal as much title as space allows, then shrink to
// a readable floor before horizontal overflow takes over. The preset controls
// that floor/ceiling/basis so users trade tab count against readable titles.
const TAB_CONTAINER_WIDTH_CLASSES_BY_WIDTH: Record<TerminalTabWidth, string> = {
  // Hug: no grow AND no shrink so the tab sizes to its title and overflows the
  // strip (scrolls) instead of collapsing; cap so one long title can't dominate.
  hug: 'min-w-[80px] max-w-[360px] flex-[0_0_auto]',
  default: 'min-w-[120px] max-w-[280px] flex-[1_1_180px] min-[1280px]:flex-[1_1_220px]',
  large: 'min-w-[160px] max-w-[340px] flex-[1_1_260px] min-[1280px]:flex-[1_1_300px]',
  'x-large': 'min-w-[200px] max-w-[420px] flex-[1_1_320px] min-[1280px]:flex-[1_1_380px]'
}

export function getTabContainerWidthClasses(
  width: TerminalTabWidth = DEFAULT_TERMINAL_TAB_WIDTH
): string {
  return TAB_CONTAINER_WIDTH_CLASSES_BY_WIDTH[width]
}

// Why: while renaming, the input (and the title being typed) must stay fully visible,
// so lift the floor well past the normal shrink limit even in a saturated tab strip.
export const TAB_EDITING_CONTAINER_WIDTH_CLASSES = 'min-w-[180px] max-w-[320px] flex-[1_1_220px]'

// Why: flexible presets give the label basis-0 (flex-1) so it truncates as tabs
// share the strip. Hug instead lets the label take its natural text width so the
// tab actually wraps the title — flex-1's basis-0 would collapse it to icons.
const TAB_LABEL_FLEX_WIDTH_CLASSES = 'min-w-0 flex-1 truncate'
const TAB_LABEL_HUG_WIDTH_CLASSES = 'min-w-0 max-w-full truncate'

export function getTabLabelWidthClasses(
  width: TerminalTabWidth = DEFAULT_TERMINAL_TAB_WIDTH
): string {
  return width === 'hug' ? TAB_LABEL_HUG_WIDTH_CLASSES : TAB_LABEL_FLEX_WIDTH_CLASSES
}
