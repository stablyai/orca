import React, { lazy, Suspense, useEffect } from 'react'
import { resumeGitHubInstall, useGitHubInstallRecord } from '@/lib/bot-github-install-record'

const GitHubInstallSurface = lazy(() =>
  import('./GitHubInstallSurface').then((module) => ({ default: module.GitHubInstallSurface }))
)

/** Always mounted, so a minimized setup outlives the bot's page; nothing loads until one is in progress. */
export function GitHubInstallMount(): React.JSX.Element | null {
  const record = useGitHubInstallRecord()
  useEffect(resumeGitHubInstall, [])
  return record ? (
    <Suspense fallback={null}>
      <GitHubInstallSurface record={record} />
    </Suspense>
  ) : null
}
