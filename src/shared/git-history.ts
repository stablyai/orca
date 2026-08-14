import {
  GIT_HISTORY_COMMIT_FORMAT,
  gitHistoryRefFromFullName,
  parseGitHistoryLog,
  shortGitHash
} from './git-history-log-parser'
import {
  GIT_HISTORY_DEFAULT_LIMIT,
  GIT_HISTORY_MAX_LIMIT,
  type GitHistoryExecutor,
  type GitHistoryItem,
  type GitHistoryItemRef,
  type GitHistoryOptions,
  type GitHistoryResult,
  type GitHistorySeam
} from './git-history-types'

export type {
  GitHistoryCursor,
  GitHistorySeam,
  GitHistoryExecutor,
  GitHistoryGraphColorId,
  GitHistoryItem,
  GitHistoryItemRef,
  GitHistoryItemStatistics,
  GitHistoryOptions,
  GitHistoryRefCategory,
  GitHistoryResult
} from './git-history-types'
export {
  GIT_HISTORY_BASE_REF_COLOR,
  GIT_HISTORY_DEFAULT_LIMIT,
  GIT_HISTORY_LANE_COLORS,
  GIT_HISTORY_MAX_LIMIT,
  GIT_HISTORY_REF_COLOR,
  GIT_HISTORY_REMOTE_REF_COLOR
} from './git-history-types'
export { compareGitHistoryItemRefsByCategory, parseGitHistoryLog } from './git-history-log-parser'

function clampHistoryLimit(limit: number | undefined): number {
  if (!Number.isFinite(limit)) {
    return GIT_HISTORY_DEFAULT_LIMIT
  }
  return Math.min(
    GIT_HISTORY_MAX_LIMIT,
    Math.max(1, Math.trunc(limit ?? GIT_HISTORY_DEFAULT_LIMIT))
  )
}

async function resolveCommit(
  git: GitHistoryExecutor,
  cwd: string,
  ref: string
): Promise<string | null> {
  if (!ref || ref.startsWith('-')) {
    return null
  }
  try {
    const { stdout } = await git(
      ['rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`],
      cwd
    )
    const oid = stdout.trim()
    return oid || null
  } catch {
    return null
  }
}

async function resolveSymbolicFullName(
  git: GitHistoryExecutor,
  cwd: string,
  ref: string
): Promise<string | null> {
  if (!ref || ref.startsWith('-')) {
    return null
  }
  try {
    const { stdout } = await git(
      ['rev-parse', '--symbolic-full-name', '--end-of-options', ref],
      cwd
    )
    // Why skip the marker: --verify swallows --end-of-options, but
    // --symbolic-full-name deliberately echoes it, so the first line is the marker
    // rather than the ref. Taking it made every branch and tag fall through
    // gitHistoryRefFromFullName's prefix checks into the "commits" category.
    return (
      stdout
        .trim()
        .split(/\r?\n/)
        .find((line) => line && line !== '--end-of-options') ?? null
    )
  } catch {
    return null
  }
}

async function resolveCurrentRef(
  git: GitHistoryExecutor,
  cwd: string,
  headOid: string
): Promise<{ currentRef: GitHistoryItemRef; branchName: string | null }> {
  try {
    const { stdout } = await git(['symbolic-ref', '--quiet', '--short', 'HEAD'], cwd)
    const branchName = stdout.trim()
    if (branchName) {
      return {
        branchName,
        currentRef: {
          id: `refs/heads/${branchName}`,
          name: branchName,
          revision: headOid,
          category: 'branches'
        }
      }
    }
  } catch {
    // Detached HEAD.
  }

  return {
    branchName: null,
    currentRef: { id: headOid, name: shortGitHash(headOid), revision: headOid, category: 'commits' }
  }
}

async function resolveUpstreamRef(
  git: GitHistoryExecutor,
  cwd: string,
  branchName: string | null
): Promise<GitHistoryItemRef | undefined> {
  if (!branchName) {
    return undefined
  }
  try {
    const { stdout } = await git(
      ['for-each-ref', '--format=%(upstream)%00%(upstream:short)', `refs/heads/${branchName}`],
      cwd
    )
    const [fullName, shortName] = stdout.split('\0')
    const upstreamRef = fullName?.trim()
    const upstreamShortName = shortName?.trim()
    if (!upstreamRef || !upstreamShortName) {
      return undefined
    }
    // Why: %(upstream:objectname) is not portable across Git versions; resolve
    // the upstream name first, then ask rev-parse for the commit object.
    const oid = await resolveCommit(git, cwd, upstreamRef)
    return oid ? gitHistoryRefFromFullName(upstreamRef, upstreamShortName, oid) : undefined
  } catch {
    return undefined
  }
}

async function resolveNamedRef(
  git: GitHistoryExecutor,
  cwd: string,
  ref: string | null | undefined
): Promise<GitHistoryItemRef | undefined> {
  const normalized = ref?.trim()
  if (!normalized || normalized.startsWith('-')) {
    return undefined
  }
  const [revision, fullName] = await Promise.all([
    resolveCommit(git, cwd, normalized),
    resolveSymbolicFullName(git, cwd, normalized)
  ])
  return revision ? gitHistoryRefFromFullName(fullName, normalized, revision) : undefined
}

function isGitHistorySeam(row: GitHistoryItem | undefined, seam: GitHistorySeam): boolean {
  return (
    row?.id === seam.id &&
    row.parentIds.length === seam.parentIds.length &&
    row.parentIds.every((parentId, index) => parentId === seam.parentIds[index])
  )
}

export async function loadGitHistoryFromExecutor(
  git: GitHistoryExecutor,
  cwd: string,
  options: GitHistoryOptions = {}
): Promise<GitHistoryResult> {
  const limit = clampHistoryLimit(options.limit)
  const headOid = await resolveCommit(git, cwd, 'HEAD')
  if (!headOid) {
    return {
      items: [],
      hasIncomingChanges: false,
      hasOutgoingChanges: false,
      hasMore: false,
      limit
    }
  }

  const { currentRef, branchName } = await resolveCurrentRef(git, cwd, headOid)
  // Why: an anchor can go stale (rebase, amend, prune, branch switch). Resolving it first means a
  // dead anchor degrades to a fresh first page instead of failing the whole panel on a bad
  // revision — and it rides the existing batch so paging costs no extra round trip.
  const requestedAnchor = options.cursor?.anchor?.trim() || undefined
  const [remoteRef, rawBaseRef, anchor] = await Promise.all([
    resolveUpstreamRef(git, cwd, branchName),
    resolveNamedRef(git, cwd, options.baseRef),
    requestedAnchor ? resolveCommit(git, cwd, requestedAnchor) : Promise.resolve(null)
  ])

  const baseRef =
    rawBaseRef && rawBaseRef.id !== remoteRef?.id && rawBaseRef.id !== currentRef.id
      ? rawBaseRef
      : undefined

  // Why: this panel is scoped to the active workspace. Upstream and base refs
  // stay as comparison metadata so old workspaces do not list newly fetched upstream/base commits.
  // Why: page by offset into a walk pinned to the cursor's anchor, so page N costs one page of
  // output rather than N pages and stays a continuation of page 1 even if HEAD moves mid-paging.
  // Why: an unresolved anchor restarts at page 1, so its offset goes with it. `loaded` counts the
  // rows already shown, and the last of those is re-read as the seam, hence -1.
  const resume =
    anchor && options.cursor && options.cursor.loaded > 0
      ? { anchor, skip: Math.trunc(options.cursor.loaded) - 1, after: options.cursor.after }
      : undefined

  let mergeBase: string | undefined
  if (remoteRef?.revision && currentRef.revision && remoteRef.revision !== currentRef.revision) {
    try {
      const { stdout } = await git(['merge-base', currentRef.revision, remoteRef.revision], cwd)
      mergeBase = stdout.trim() || undefined
    } catch {
      mergeBase = undefined
    }
  }

  // Why: skipping into the walk keeps every page the same size however deep paging goes, and keeps
  // the order identical to one uninterrupted walk, so no commit is repeated or dropped. The extra
  // row a resumed page asks for is the seam: the last row already on screen, re-read to prove the
  // walk still leads with it. +1 beyond that tells a full page apart from the last one.
  const readPage = async (tip: string, skip: number, extra: number): Promise<GitHistoryItem[]> => {
    const { stdout } = await git(
      [
        'log',
        `--format=${GIT_HISTORY_COMMIT_FORMAT}`,
        '-z',
        '--topo-order',
        '--decorate=full',
        `-n${limit + 1 + extra}`,
        ...(skip > 0 ? [`--skip=${skip}`] : []),
        tip
      ],
      cwd
    )
    return parseGitHistoryLog(stdout)
  }

  let walkTip = resume?.anchor ?? headOid
  let skip = resume?.skip ?? 0
  let parsed = await readPage(walkTip, skip, resume ? 1 : 0)
  let continuedCursor = false
  if (resume) {
    // Why: an anchor resolving does not prove its ancestry is unchanged, and neither does the seam
    // keeping its id — replace refs and grafts rewrite a commit's parents in place. If the walk no
    // longer produces exactly the row the previous page ended on, this is a different history and
    // splicing it on would skip commits and leave the seam's drawn edge pointing at nothing.
    continuedCursor = isGitHistorySeam(parsed[0], resume.after)
    if (continuedCursor) {
      parsed = parsed.slice(1)
    } else {
      walkTip = headOid
      skip = 0
      parsed = await readPage(walkTip, skip, 0)
    }
  }
  const items = parsed.slice(0, limit)
  const seamRow = items.at(-1)
  const hasMore = parsed.length > limit
  // Rows of this walk now accounted for: those skipped, the seam, and this page.
  const loaded = skip + (continuedCursor ? 1 : 0) + items.length
  const hasIncomingChanges =
    Boolean(remoteRef?.revision && mergeBase) && remoteRef?.revision !== mergeBase
  const hasOutgoingChanges =
    Boolean(currentRef.revision && remoteRef?.revision && mergeBase) &&
    currentRef.revision !== mergeBase

  return {
    items,
    currentRef,
    remoteRef,
    baseRef,
    mergeBase,
    hasIncomingChanges,
    hasOutgoingChanges,
    hasMore,
    limit,
    continuedCursor,
    nextCursor:
      hasMore && items.length > 0
        ? {
            anchor: walkTip,
            loaded,
            after: { id: seamRow?.id ?? '', parentIds: seamRow?.parentIds ?? [] }
          }
        : undefined
  }
}
