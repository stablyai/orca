/** Guest frame → main: a trusted click held Shift with Cmd or Ctrl; main decides whether that is the system-browser chord. */
export const BROWSER_GUEST_LINK_CHORD_CLICK_CHANNEL = 'browser:guestLinkChordClick'

export type BrowserGuestLinkChordClick = { metaKey: boolean; ctrlKey: boolean }
