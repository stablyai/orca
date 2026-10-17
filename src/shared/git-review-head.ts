import { readGitConfigSnapshotValue, type GitConfigSnapshot } from './git-config-snapshot-runner'

/**
 * Where a branch's review comes from: the remote branch it is pushed to, or a review the branch
 * was checked out from (`branch.<b>.merge = refs/pull/N/head` from `gh pr checkout`, or
 * `refs/merge-requests/N/head` from `glab mr checkout`).
 */
export type ReviewHead =
  | { kind: 'branch'; remote: string; branch: string }
  | { kind: 'review'; number: number }

// Remotes reviews are filed against; a differently named branch tracked there is a base, not a head.
const REVIEW_BASE_REMOTES = new Set(['origin', 'upstream'])

function remoteNameForUrl(config: GitConfigSnapshot, url: string): string | null {
  for (const [key, values] of config) {
    const match = /^remote\.(.+)\.url$/.exec(key)
    if (match?.[1] && values.includes(url)) {
      return match[1]
    }
  }
  return null
}

function readRemote(config: GitConfigSnapshot, key: string): string | null {
  const remote = readGitConfigSnapshotValue(config, key)
  if (!remote || remote === '.') {
    return null
  }
  return remoteNameForUrl(config, remote) ?? remote
}

/**
 * The branch's review head, following where a plain push of this branch lands (as `gh pr view`
 * does), never the branch it pulls from: a branch tracking `origin/develop` is not develop.
 */
export function readReviewHead(config: GitConfigSnapshot, branch: string): ReviewHead {
  const merge = readGitConfigSnapshotValue(config, `branch.${branch}.merge`)
  const reviewRef = merge ? /^refs\/(?:pull|merge-requests)\/(\d+)\/head$/.exec(merge) : null
  if (reviewRef) {
    return { kind: 'review', number: Number(reviewRef[1]) }
  }
  const trackedRemote = readRemote(config, `branch.${branch}.remote`)
  const remote =
    readRemote(config, `branch.${branch}.pushRemote`) ??
    readRemote(config, 'remote.pushDefault') ??
    trackedRemote ??
    'origin'
  const trackedBranch = merge?.startsWith('refs/heads/') ? merge.slice('refs/heads/'.length) : null
  if (trackedBranch && trackedBranch !== branch && remote === trackedRemote) {
    const pushDefault = readGitConfigSnapshotValue(config, 'push.default')
    if (
      pushDefault === 'upstream' ||
      pushDefault === 'tracking' ||
      !REVIEW_BASE_REMOTES.has(remote)
    ) {
      // A contributor fork's branch checked out under a local name is that branch's review head.
      return { kind: 'branch', remote, branch: trackedBranch }
    }
  }
  return { kind: 'branch', remote, branch }
}
