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

// A bot's pinned Home (PinnedHomeTabSlot, rendered-tab-strip, and the pane header's pinned-Home
// selectors in TabGroupPanel, TabGroupStripActions and TabGroupPaneActionsMenu use these literals).
/** Home keeps this width until only the "+N" chip is left beside it. */
export const PINNED_HOME_WIDTH_PX = 144
/** Home's label hides whole below this: 84 idle titled tab + 16 working/unread dot + 14 color dot. */
export const PINNED_HOME_LABEL_MIN_PX = 114
/** Home's color dot hides below this: 44 idle icon tab + 16 + 14. */
export const PINNED_HOME_COLOR_DOT_MIN_PX = 74
/** Home's pin hides below this: 44 + 16. */
export const PINNED_HOME_PIN_MIN_PX = 60
/** At or below this tab-strip width Home is a fixed icon-only tab (TAB_ICON_ONLY_WIDTH_PX), so the "+N" chip stays whole:
 * 32 + 38 chip + 1 border + 8 action padding + slack. */
export const PINNED_HOME_ICON_BELOW_PX = 86
/** At or below this, beside two or more other tabs, Home's slot hides; the plan is then always the "+N" chip, whose list
 * leads with Home. */
export const PINNED_HOME_HIDE_BELOW_PX = 78
/** Home beside other tabs adds a second tab floor, so each strip threshold above moves up by this:
 * "+" 126, pane ⋯ 154 (118 folded), quick commands 203, drag handle 243. */
export const PINNED_HOME_EXTRA_FLOOR_PX = TAB_STRIP_FLOOR_PX
