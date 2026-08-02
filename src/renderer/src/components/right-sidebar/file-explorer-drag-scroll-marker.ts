// Why: Chromium swallows wheel scroll started over a draggable element; the
// wheel-capture handler keys off this marker. Shared so producer/consumer can't drift.
export const FILE_EXPLORER_DRAGGABLE_SELECTOR = '[data-explorer-draggable="true"]'
