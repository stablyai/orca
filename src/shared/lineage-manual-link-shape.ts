import type { LineageManualLink, LineageManualLinkKind } from './lineage-discovery-types'

const KINDS: readonly LineageManualLinkKind[] = ['pr', 'branch', 'worktree']

export function lineageManualLinkKind(
  link: Pick<LineageManualLink, 'kind'>
): LineageManualLinkKind {
  return link.kind ?? 'pr'
}

function isKind(value: unknown): value is LineageManualLinkKind {
  return KINDS.some((kind) => kind === value)
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

function isOptionalString(value: unknown): boolean {
  return value === undefined || typeof value === 'string'
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0
}

/** Runtime guard for persisted and IPC-borne links; anything malformed is dropped by callers. */
export function isLineageManualLink(value: unknown): value is LineageManualLink {
  if (!value || typeof value !== 'object') {
    return false
  }
  const link: Partial<Record<keyof LineageManualLink, unknown>> = value
  if (
    !isNonEmptyString(link.id) ||
    typeof link.repoName !== 'string' ||
    typeof link.addedAt !== 'number' ||
    (link.kind !== undefined && !isKind(link.kind)) ||
    !isOptionalString(link.repoId) ||
    !isOptionalString(link.url) ||
    !isOptionalString(link.branch) ||
    !isOptionalString(link.worktreePath) ||
    !isOptionalString(link.worktreeId) ||
    (link.number !== undefined && !isPositiveInteger(link.number))
  ) {
    return false
  }
  switch (link.kind ?? 'pr') {
    case 'pr':
      return isPositiveInteger(link.number)
    case 'branch':
      return isNonEmptyString(link.branch)
    case 'worktree':
      return isNonEmptyString(link.worktreePath)
  }
}

/** Drops trailing path separators so `/w/a/` and `/w/a` name one worktree; a bare root is kept. */
export function normalizeLineageWorktreePath(worktreePath: string): string {
  const trimmed = worktreePath.replace(/[\\/]+$/, '')
  return trimmed === '' || /^[A-Za-z]:$/.test(trimmed) ? worktreePath : trimmed
}

/** invariant: one link per kind + repo + target; repo is its id, or its name (case-insensitive) for links saved before ids. */
export function lineageManualLinkDedupeKey(link: LineageManualLink): string {
  const kind = lineageManualLinkKind(link)
  const target =
    kind === 'pr'
      ? String(link.number)
      : kind === 'branch'
        ? (link.branch ?? '')
        : normalizeLineageWorktreePath(link.worktreePath ?? '')
  const repo = link.repoId ? `id:${link.repoId}` : `name:${link.repoName.toLowerCase()}`
  return `${kind}\u0000${repo}\u0000${target}`
}

/** Keeps the first link for each dedupe key and each id. */
export function dedupeLineageManualLinks(links: LineageManualLink[]): LineageManualLink[] {
  const seenKeys = new Set<string>()
  const seenIds = new Set<string>()
  return links.filter((link) => {
    const key = lineageManualLinkDedupeKey(link)
    if (seenKeys.has(key) || seenIds.has(link.id)) {
      return false
    }
    seenKeys.add(key)
    seenIds.add(link.id)
    return true
  })
}
