// One width authority for the tab strip. All values are outer widths in CSS px.

/** Titled tabs shrink together down to this; below it inactive tabs go icon-only. */
export const TAB_MIN_WIDTH_WITH_TITLE_PX = 80
export const TAB_ICON_ONLY_WIDTH_PX = 32
/** The active tab keeps its title down to this while other tabs can still become icons or hide. */
export const ACTIVE_TAB_MIN_WIDTH_PX = 104
/** Under this a title shows too few glyphs to read, so the active tab becomes an icon. */
export const ACTIVE_TAB_MIN_TITLED_WIDTH_PX = 56
export const ACTIVE_TAB_CONDENSED_MAX_PX = 200
/** "+N" chip that opens the list of every tab. */
export const TAB_OVERFLOW_CHIP_WIDTH_PX = 38

// Narrow tab-group strip budget from #41249; its container-query literals in TabGroupPanel and
// tab-bar-surface are these values (Tailwind needs literal class names).
/** A narrow strip always keeps a grabbable tab this wide. */
export const TAB_STRIP_FLOOR_PX = 40
/** "+" hides below this strip width: 40 tab floor + 36 "+" + 8 action padding + 2 slack. */
export const NEW_TAB_BUTTON_HIDE_BELOW_PX = 86
/** Pane ⋯ hides below this: 40 + 36 + 8 + 28 ⋯ + 2. */
export const PANE_ACTIONS_HIDE_BELOW_PX = 114
/** With "+" folded into ⋯ (chrome fold step 2), ⋯ only needs room beside the tab floor: 40 + 8 + 28 + 2. */
export const FOLDED_PANE_ACTIONS_HIDE_BELOW_PX = 78
/** Quick commands hide below this: 114 + 47 widest trigger + 2 gap. */
export const QUICK_COMMANDS_HIDE_BELOW_PX = 163
