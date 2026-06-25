// Why: sidebar primaries rotate labels as git/review state changes. Filling the
// pane keeps their right edge aligned with the surrounding editor chrome; the
// primary half must shrink first so split-button chevrons never overflow.
export const RIGHT_SIDEBAR_SPLIT_ACTION_ROW_CLASS =
  'flex w-full min-w-0 items-stretch [&>*:first-child]:flex-1 [&>*:first-child>button]:w-full [&>button:first-child]:w-full'

export const RIGHT_SIDEBAR_MORPHING_PRIMARY_BUTTON_CLASS = 'w-[10.5rem] min-w-0 max-w-full shrink'

// Covers "Squash and merge" and "Disable auto-merge".
export const RIGHT_SIDEBAR_MERGE_PRIMARY_BUTTON_CLASS = 'w-[11.5rem] min-w-0 max-w-full shrink'

export const RIGHT_SIDEBAR_PRIMARY_BUTTON_LABEL_CLASS = 'block min-w-0 truncate'

// PR full-page and item-dialog asides share the same merge/state labels.
export const REVIEW_ACTION_MERGE_BUTTON_CLASS = RIGHT_SIDEBAR_MERGE_PRIMARY_BUTTON_CLASS

export const REVIEW_ACTION_STATE_BUTTON_CLASS = 'w-[11.5rem] min-w-0 max-w-full shrink'
