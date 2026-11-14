import type { GitDiffResult } from '../../../../../shared/git/diff/git-diff-compare-types'
import type { GitStatusEntry } from '../../../../../shared/git/status/git-status-types'

export type GitHeadBaseline = string[] | null

const MAX_CACHED_BASELINES = 32
const settledBaselines = new Map<string, GitHeadBaseline>()
const inFlightBaselines = new Map<string, Promise<GitHeadBaseline>>()

const NEW_FILE_STATUSES: ReadonlySet<GitStatusEntry['status']> = new Set([
  'untracked',
  'added',
  'renamed',
  'copied'
])

/** Identity of a file's HEAD blob; null when there is no blob to compare or a conflict owns the gutter. */
export function getGitHeadBaselineKey(args: {
  worktreeId: string
  relativePath: string
  head: string | undefined
  statusEntries: readonly GitStatusEntry[] | undefined
}): string | null {
  const { worktreeId, relativePath, head, statusEntries } = args
  if (!head || head === '(initial)' || !statusEntries) {
    return null
  }
  const fileEntries = statusEntries.filter((entry) => entry.path === relativePath)
  if (
    fileEntries.some(
      (entry) => NEW_FILE_STATUSES.has(entry.status) || entry.conflictStatus === 'unresolved'
    )
  ) {
    return null
  }
  // Why status is part of the key: a commit inside a submodule moves its blob without moving this HEAD.
  const status = fileEntries.map((entry) => `${entry.area}:${entry.status}`).sort()
  return JSON.stringify([worktreeId, relativePath, head, status])
}

/** Matches Monaco, which drops a BOM and breaks lines on LF, CRLF and CR, so both sides align. */
function splitBaselineLines(text: string): string[] {
  return (text.charCodeAt(0) === 0xfeff ? text.slice(1) : text).split(/\r\n|\r|\n/)
}

/** Throws when the read cannot be trusted, so the caller neither paints nor caches it. */
export function toGitHeadBaseline(result: GitDiffResult): GitHeadBaseline {
  if (result.kind !== 'text' || result.largeDiffRenderLimit?.limited === true) {
    return null
  }
  // Why: a failed HEAD read also comes back empty, and reverting against it would wipe the file.
  if (result.originalContent === '' && result.modifiedContent !== '') {
    throw new Error('HEAD content unavailable')
  }
  return splitBaselineLines(result.originalContent)
}

export function peekGitHeadBaseline(key: string): GitHeadBaseline | undefined {
  return settledBaselines.get(key)
}

/** Failed reads are not cached, so the next key change or remount retries. */
export function loadGitHeadBaseline(
  key: string,
  read: () => Promise<GitHeadBaseline>
): Promise<GitHeadBaseline> {
  const pending = inFlightBaselines.get(key)
  if (pending) {
    return pending
  }
  const promise = read()
    .then((baseline) => {
      settledBaselines.delete(key)
      settledBaselines.set(key, baseline)
      const oldest = settledBaselines.keys().next()
      if (settledBaselines.size > MAX_CACHED_BASELINES && !oldest.done) {
        settledBaselines.delete(oldest.value)
      }
      return baseline
    })
    .finally(() => {
      inFlightBaselines.delete(key)
    })
  inFlightBaselines.set(key, promise)
  return promise
}
