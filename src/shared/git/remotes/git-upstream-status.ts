import type { GitUpstreamStatus } from '../status/git-status-types'

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

export type DivergedUpstreamProbe = {
  behindCommitsArePatchEquivalent: boolean
  // The upstream tip, so a marker set at rebase time notices any later fetch that moves it.
  upstreamOid?: string
}

/** Reads `%m %H` right-only cherry-mark lines in topo order, where the upstream tip comes first. */
export function parseDivergedUpstreamProbe(cherryMarkOutput: string): DivergedUpstreamProbe {
  let upstreamOid: string | undefined
  for (const rawLine of iterateGitOutputLines(cherryMarkOutput)) {
    const oid = rawLine.trim().split(/\s+/)[1]
    if (oid) {
      upstreamOid = oid
      break
    }
  }
  return {
    behindCommitsArePatchEquivalent: upstreamOnlyCommitsArePatchEquivalent(cherryMarkOutput),
    ...(upstreamOid ? { upstreamOid } : {})
  }
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

// Create PR auto-prepare can fast-forward only behind-only branches with no local unique commits; share eligibility with intent resolution.
export function isBehindOnlyUpstream(status: GitUpstreamStatus | undefined): boolean {
  return status?.hasUpstream === true && status.ahead === 0 && status.behind > 0
}
