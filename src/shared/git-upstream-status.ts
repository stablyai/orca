import type { GitUpstreamStatus } from './git-status-types'

export function upstreamOnlyCommitsArePatchEquivalent(cherryMarkOutput: string): boolean {
  let hasCommit = false
  for (const rawLine of iterateGitOutputLines(cherryMarkOutput)) {
    const line = rawLine.trim()
    if (!line) {
      continue
    }
    hasCommit = true
    if (!line.startsWith('=')) {
      return false
    }
  }
  return hasCommit
}

function* iterateGitOutputLines(output: string): Generator<string> {
  let lineStart = 0

  for (let index = 0; index < output.length; index++) {
    const code = output.charCodeAt(index)
    if (code !== 10 && code !== 13) {
      continue
    }

    yield output.slice(lineStart, index)
    if (code === 13 && output.charCodeAt(index + 1) === 10) {
      index++
    }
    lineStart = index + 1
  }

  if (lineStart <= output.length) {
    yield output.slice(lineStart)
  }
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

// Why: behind-only is the only auto-prepare case Create PR can safely handle
// with a pure fast-forward (no local unique commits to reconcile). Eligibility
// and the intent remote-step resolver must share this predicate so the button
// and the one-click flow never disagree on what "behind-only" means.
export function isBehindOnlyUpstream(status: GitUpstreamStatus | undefined): boolean {
  return status?.hasUpstream === true && status.ahead === 0 && status.behind > 0
}
