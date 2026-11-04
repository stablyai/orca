import React from 'react'
import { useAppStore } from '@/store'
import { PreflightBanner } from '../landing-preflight-banner'
import { useLandingPreflightRuntime } from '../landing-preflight-runtime'
import { LandingShortcutHints } from '../landing-shortcut-hints'

/** Keeps Landing's setup nudges and navigation hints when Home stands in for it. */
export function HomeLandingFooter(): React.JSX.Element {
  const repos = useAppStore((s) => s.repos)
  const { preflightIssues } = useLandingPreflightRuntime()
  return (
    <footer className="flex shrink-0 flex-col items-center gap-3 px-3 pb-5 md:px-5">
      {preflightIssues.length > 0 ? (
        <PreflightBanner issues={preflightIssues} repos={repos} />
      ) : null}
      <LandingShortcutHints compact className="justify-center" />
    </footer>
  )
}
