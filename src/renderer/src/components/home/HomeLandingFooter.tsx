import React from 'react'
import { LandingPreflightNotice } from '../Landing'
import { LandingShortcutHints } from '../landing-shortcut-hints'

/** Keeps Landing's setup nudges and navigation hints when Home stands in for it. */
export function HomeLandingFooter(): React.JSX.Element {
  return (
    <footer className="flex shrink-0 flex-col items-center gap-3 px-3 pb-5 md:px-5">
      <LandingPreflightNotice />
      <LandingShortcutHints compact className="justify-center" />
    </footer>
  )
}
