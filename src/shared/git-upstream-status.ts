import type { GitUpstreamStatus } from './git-status-types'

export function upstreamOnlyCommitsArePatchEquivalent(cherryMarkOutput: string): boolean {
  const lines = cherryMarkOutput
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
  return lines.length > 0 && lines.every((line) => line.startsWith('='))
}

export function shouldForcePushWithLeaseForUpstream(
  status: GitUpstreamStatus | undefined
): boolean {
  return (
    status?.hasUpstream === true &&
    status.ahead > 0 &&
    status.behind > 0 &&
    status.behindCommitsArePatchEquivalent === true
  )
}
