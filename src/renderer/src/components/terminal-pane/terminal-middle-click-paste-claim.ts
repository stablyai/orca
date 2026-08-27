export type MiddleClickPasteClaimInput = {
  mouseTrackingMode: string
  mouseEventsRequireAlt: boolean
  altKey: boolean
}

/**
 * Whether Orca pastes the primary selection itself instead of leaving the middle
 * click to a mouse-tracking TUI.
 */
export function shouldClaimMiddleClickForPrimarySelection(
  input: MiddleClickPasteClaimInput
): boolean {
  if (input.mouseTrackingMode === 'none') {
    return true
  }
  // Why: under the Alt gate an unmodified click never reaches the TUI, so deferring drops the paste.
  return input.mouseEventsRequireAlt && !input.altKey
}
