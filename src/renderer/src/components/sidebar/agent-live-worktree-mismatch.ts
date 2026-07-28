import {
  getRepoExecutionHostId,
  getWorktreeExecutionHostId,
  parseExecutionHostId,
  toRuntimeExecutionHostId,
  type ExecutionHostId
} from '../../../../shared/execution-host'
import {
  isWindowsAbsolutePathLike,
  normalizeRuntimePathSeparators
} from '../../../../shared/cross-platform-path'
import { parseWslUncPath } from '../../../../shared/wsl-paths'
import type { DashboardAgentRow } from '@/components/dashboard/useDashboardData'
import type {
  DetectedWorktreeListResult,
  Repo,
  Worktree,
  WorktreeOwnership
} from '../../../../shared/types'

/** Minimal display-only description of a mismatch destination. */
export type AgentLiveWorktreeMismatch = {
  destinationWorktreeId: string
  destinationLabel: string
}

/** A worktree the resolver may attribute a reported cwd to. */
export type AgentLiveWorktreeMismatchCandidate = {
  id: string
  repoId: string
  path: string
  branch?: string
  displayName?: string
  hostId?: ExecutionHostId
  runtimeOwnerEnvironmentId?: string
  /** Present only for detected rows; hidden rows need an authoritative scope. */
  ownership?: WorktreeOwnership
  visible: boolean
}

type OwnerIdentity = {
  /** Refresh scope used to select rows and read their authority record. */
  catalogScope: ExecutionHostId
  /** Filesystem host used to compare locations. */
  filesystemHostId: ExecutionHostId
}

function resolveCatalogScope(
  worktree: Pick<Worktree, 'hostId' | 'runtimeOwnerEnvironmentId'>,
  repo: Pick<Repo, 'connectionId' | 'executionHostId'>
): ExecutionHostId {
  // Why: a paired runtime publishes SSH-owned checkouts — rows refresh under the
  // runtime scope while their filesystem identity stays the SSH target.
  return worktree.runtimeOwnerEnvironmentId
    ? toRuntimeExecutionHostId(worktree.runtimeOwnerEnvironmentId)
    : (worktree.hostId ?? getRepoExecutionHostId(repo))
}

function resolveOwnerIdentity(
  worktree: Pick<Worktree, 'hostId' | 'runtimeOwnerEnvironmentId'>,
  repo: Pick<Repo, 'connectionId' | 'executionHostId'>
): OwnerIdentity | null {
  const catalogScope = resolveCatalogScope(worktree, repo)
  const filesystemHostId = getWorktreeExecutionHostId(worktree, repo)
  // Why: fail closed — an unparseable host is missing provenance, not a wildcard.
  if (!parseExecutionHostId(catalogScope) || !parseExecutionHostId(filesystemHostId)) {
    return null
  }
  return { catalogScope, filesystemHostId }
}

function candidateMatchesOwnerIdentity(
  candidate: AgentLiveWorktreeMismatchCandidate,
  owner: OwnerIdentity,
  ownerRepoId: string
): boolean {
  if (candidate.repoId !== ownerRepoId) {
    return false
  }
  const candidateScope = candidate.runtimeOwnerEnvironmentId
    ? toRuntimeExecutionHostId(candidate.runtimeOwnerEnvironmentId)
    : candidate.hostId
  // Why: a record with no stable host identity carries ambiguous provenance;
  // a transient hook connection id is not a substitute for `ssh:<targetId>`.
  if (!candidateScope || !candidate.hostId) {
    return false
  }
  return candidateScope === owner.catalogScope && candidate.hostId === owner.filesystemHostId
}

// ─── Path comparison ────────────────────────────────────────────────

type ComparablePath = {
  /** Case-folded key used for equality and prefix tests. */
  key: string
  /** Segment count of the key, for longest-root selection. */
  specificity: number
  /** WSL distro proven by the path's own shape, when any. */
  wslDistro: string | null
}

function collapseDots(value: string, isWindowsFlavor: boolean): string {
  const normalized = isWindowsFlavor
    ? normalizeRuntimePathSeparators(value)
    : value.replace(/\/+/g, '/')
  const uncPrefix = normalized.startsWith('//') ? '//' : ''
  const driveMatch = uncPrefix ? null : normalized.match(/^([A-Za-z]:)\//)
  const root = driveMatch ? `${driveMatch[1]}/` : uncPrefix || '/'
  const rest = normalized.slice(root.length)
  const segments: string[] = []
  for (const segment of rest.split('/')) {
    if (!segment || segment === '.') {
      continue
    }
    if (segment === '..') {
      segments.pop()
      continue
    }
    segments.push(segment)
  }
  return `${root}${segments.join('/')}`
}

function toComparablePath(value: string): ComparablePath | null {
  const trimmed = value.trim()
  if (!trimmed) {
    return null
  }
  const isWindowsFlavor = isWindowsAbsolutePathLike(trimmed)
  const collapsed = collapseDots(trimmed, isWindowsFlavor)
  const wsl = parseWslUncPath(collapsed)
  if (wsl) {
    // Why: the UNC alias and distro fold case-insensitively; the Linux tail does not.
    const tail = collapseDots(wsl.linuxPath, false)
    return {
      key: `wsl:${wsl.distro.toLowerCase()}${tail === '/' ? '' : tail}`,
      specificity: tail.split('/').filter(Boolean).length,
      wslDistro: wsl.distro.toLowerCase()
    }
  }
  if (isWindowsFlavor) {
    const key = collapsed.toLowerCase()
    return { key, specificity: key.split('/').filter(Boolean).length, wslDistro: null }
  }
  return {
    key: collapsed,
    specificity: collapsed.split('/').filter(Boolean).length,
    wslDistro: null
  }
}

/**
 * Reads a Linux path as living inside the owner's proven WSL distro so a hook
 * that reports `/home/x` can match a `\\wsl.localhost\<distro>\home\x` root.
 * Without that proof the bare path stays unbridged and matches no UNC root.
 */
function bridgeLinuxPathIntoWslDistro(
  reported: ComparablePath,
  distro: string | null
): ComparablePath {
  if (!distro || reported.wslDistro || !reported.key.startsWith('/')) {
    return reported
  }
  const tail = reported.key === '/' ? '' : reported.key
  return { key: `wsl:${distro}${tail}`, specificity: reported.specificity, wslDistro: distro }
}

function containsAtSegmentBoundary(rootKey: string, candidateKey: string): boolean {
  if (candidateKey === rootKey) {
    return true
  }
  const boundedRoot = rootKey.endsWith('/') ? rootKey : `${rootKey}/`
  return candidateKey.startsWith(boundedRoot)
}

// ─── Resolution ─────────────────────────────────────────────────────

function destinationLabel(candidate: AgentLiveWorktreeMismatchCandidate): string | null {
  const branch = candidate.branch?.trim().replace(/^refs\/heads\//, '')
  if (branch) {
    return branch
  }
  const displayName = candidate.displayName?.trim()
  if (displayName) {
    return displayName
  }
  const basename = candidate.path
    .replace(/[\\/]+$/g, '')
    .split(/[\\/]/)
    .findLast(Boolean)
  return basename ?? null
}

export type ResolveAgentLiveWorktreeMismatchArgs = {
  reportedCwd: string | undefined
  ownerWorktree: Worktree
  ownerRepo: Repo
  candidates: readonly AgentLiveWorktreeMismatchCandidate[]
}

/**
 * Pure, fail-closed mapping from an agent's reported cwd to a sibling worktree
 * of the same repo, host, and catalog scope. Returns null when the agent is in
 * its own worktree, the path is unknown, or the best match is ambiguous.
 */
export function resolveAgentLiveWorktreeMismatch(
  args: ResolveAgentLiveWorktreeMismatchArgs
): AgentLiveWorktreeMismatch | null {
  // Why: folder workspaces have no authoritative sibling-worktree catalog.
  if (!args.reportedCwd || args.ownerRepo.kind === 'folder') {
    return null
  }
  const owner = resolveOwnerIdentity(args.ownerWorktree, args.ownerRepo)
  if (!owner) {
    return null
  }
  const rawReported = toComparablePath(args.reportedCwd)
  if (!rawReported) {
    return null
  }
  // Why: only the owner checkout proves which distro a bare Linux cwd belongs
  // to; borrowing a candidate's distro would match across unrelated distros.
  const reported = bridgeLinuxPathIntoWslDistro(
    rawReported,
    toComparablePath(args.ownerWorktree.path)?.wslDistro ?? null
  )

  let best: { candidate: AgentLiveWorktreeMismatchCandidate; specificity: number } | null = null
  let ambiguous = false
  for (const candidate of args.candidates) {
    if (!candidateMatchesOwnerIdentity(candidate, owner, args.ownerRepo.id)) {
      continue
    }
    const candidatePath = toComparablePath(candidate.path)
    if (!candidatePath) {
      continue
    }
    if (!containsAtSegmentBoundary(candidatePath.key, reported.key)) {
      continue
    }
    if (!best || candidatePath.specificity > best.specificity) {
      best = { candidate, specificity: candidatePath.specificity }
      ambiguous = false
      continue
    }
    if (candidatePath.specificity === best.specificity && candidate.id !== best.candidate.id) {
      // Why: equally specific distinct roots must not be resolved by array order.
      ambiguous = true
    }
  }

  if (!best || ambiguous) {
    return null
  }
  if (best.candidate.id === args.ownerWorktree.id) {
    return null
  }
  const label = destinationLabel(best.candidate)
  return label ? { destinationWorktreeId: best.candidate.id, destinationLabel: label } : null
}

/**
 * Stamps `liveWorktreeMismatch` on the rows that are live and backed by a real
 * actionable pane. Retained, title-only inferred, and in-process subagent rows
 * carry no reported location and are left untouched.
 */
export function attachAgentLiveWorktreeMismatch(
  rows: readonly DashboardAgentRow[],
  args: Omit<ResolveAgentLiveWorktreeMismatchArgs, 'reportedCwd'>
): DashboardAgentRow[] {
  const byReportedCwd = new Map<string, AgentLiveWorktreeMismatch | null>()
  let changed = false
  const next = rows.map((row) => {
    const reportedCwd = row.rowSource === 'live' ? row.entry.reportedCwd : undefined
    if (!reportedCwd) {
      return row
    }
    let mismatch = byReportedCwd.get(reportedCwd)
    if (mismatch === undefined) {
      mismatch = resolveAgentLiveWorktreeMismatch({ ...args, reportedCwd })
      byReportedCwd.set(reportedCwd, mismatch)
    }
    if (!mismatch) {
      return row
    }
    changed = true
    return { ...row, liveWorktreeMismatch: mismatch }
  })
  return changed ? next : (rows as DashboardAgentRow[])
}

// ─── Candidate assembly ─────────────────────────────────────────────

export type BuildAgentLiveWorktreeMismatchCandidatesArgs = {
  ownerWorktree: Worktree
  ownerRepo: Repo
  visibleWorktrees: readonly Worktree[] | undefined
  detected: DetectedWorktreeListResult | undefined
}

/**
 * Visible workspace rows are always eligible; hidden detected rows only when the
 * latest refresh for their own catalog scope was authoritative.
 */
export function buildAgentLiveWorktreeMismatchCandidates(
  args: BuildAgentLiveWorktreeMismatchCandidatesArgs
): AgentLiveWorktreeMismatchCandidate[] {
  const owner = resolveOwnerIdentity(args.ownerWorktree, args.ownerRepo)
  if (!owner || args.ownerRepo.kind === 'folder') {
    return []
  }
  const candidates: AgentLiveWorktreeMismatchCandidate[] = []
  const seenIds = new Set<string>()
  const push = (candidate: AgentLiveWorktreeMismatchCandidate): void => {
    if (
      seenIds.has(candidate.id) ||
      !candidateMatchesOwnerIdentity(candidate, owner, args.ownerRepo.id)
    ) {
      return
    }
    seenIds.add(candidate.id)
    candidates.push(candidate)
  }

  // Why: the owner competes as a candidate so a nested destination only wins by
  // being the strictly longer root, never by array order.
  push({ ...args.ownerWorktree, visible: true })
  for (const worktree of args.visibleWorktrees ?? []) {
    push({ ...worktree, visible: true })
  }
  const scopeAuthority = args.detected?.authorityByHostId?.[owner.catalogScope]
  if (scopeAuthority?.authoritative !== true) {
    return candidates
  }
  for (const worktree of args.detected?.worktrees ?? []) {
    push(worktree)
  }
  return candidates
}
