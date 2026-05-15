import React from 'react'
import { GitHubRateLimitCompact } from './github-rate-limit-display'

export default function GitHubRateLimitPill(): React.JSX.Element | null {
  return <GitHubRateLimitCompact label="GitHub API budget" tooltipSide="bottom" />
}
