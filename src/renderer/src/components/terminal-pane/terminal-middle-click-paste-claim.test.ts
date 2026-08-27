import { describe, expect, it } from 'vitest'
import { shouldClaimMiddleClickForPrimarySelection } from './terminal-middle-click-paste-claim'

describe('shouldClaimMiddleClickForPrimarySelection', () => {
  it.each([
    { mouseTrackingMode: 'none', mouseEventsRequireAlt: false, altKey: false, claims: true },
    { mouseTrackingMode: 'none', mouseEventsRequireAlt: true, altKey: false, claims: true },
    // A tracking TUI owns the click while nothing gates it.
    { mouseTrackingMode: 'vt200', mouseEventsRequireAlt: false, altKey: false, claims: false },
    { mouseTrackingMode: 'vt200', mouseEventsRequireAlt: false, altKey: true, claims: false },
    // Gated and unmodified: the report never arrives, so Orca pastes instead of dropping it.
    { mouseTrackingMode: 'vt200', mouseEventsRequireAlt: true, altKey: false, claims: true },
    // Gated but alt-held: the report does arrive, so the TUI keeps the click.
    { mouseTrackingMode: 'vt200', mouseEventsRequireAlt: true, altKey: true, claims: false }
  ])(
    'mode=$mouseTrackingMode requireAlt=$mouseEventsRequireAlt alt=$altKey claims=$claims',
    ({ claims, ...input }) => {
      expect(shouldClaimMiddleClickForPrimarySelection(input)).toBe(claims)
    }
  )
})
