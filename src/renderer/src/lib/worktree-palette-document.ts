import { getWorktreeHostIdentity } from '../../../shared/worktree/host-qualified-identity'
import { issueCacheKey as getIssueCacheKey } from '@/store/slices/github'
import { buildPaletteDocument, type PaletteDocument } from './palette-match/palette-document'
import type { PaletteComposedEvidence } from './palette-match/evidence-composer'
import {
  buildWorktreeAutomationEvidence,
  buildWorktreeCommentEvidence,
  buildWorktreeIssueEvidence,
  buildWorktreeLinkedTaskEvidence,
  buildWorktreePortEvidence,
  buildWorktreeReviewEvidence,
  type WorktreePaletteReviewSource
} from './worktree-palette-evidence'
import {
  resolveWorktreeBranchLabel,
  resolveWorktreeDisplayName
} from './worktree-default-display-name'
import type { HostedReviewInfo } from '../../../shared/hosted-review'
import type { Repo } from '../../../shared/repo-types'
import type { Worktree } from '../../../shared/worktree/types'
import { resolvePaletteRepoForWorktree } from './palette-repo-resolution'

export const WORKTREE_PALETTE_NAME_FIELD_ID = 'name'
export const WORKTREE_PALETTE_BRANCH_FIELD_ID = 'branch'
export const WORKTREE_PALETTE_REPO_FIELD_ID = 'repo'
export const WORKTREE_PALETTE_HOST_FIELD_ID = 'host'

export type PRCacheEntry = { data?: { number: number; title: string } | null } | undefined
export type IssueCacheEntry = { data?: { number: number; title: string } | null } | undefined

/**
 * `board` is the Kanban profile: cards may only be filtered by text printed on
 * them, so palette-only evidence such as ports and reviews is excluded.
 */
export type WorktreePaletteEvidencePolicy = 'palette' | 'board'

export type WorktreePaletteDocumentSources = {
  repoMap: ReadonlyMap<string, Repo>
  repoMapByHostIdentity?: ReadonlyMap<string, Repo>
  prCache?: Record<string, PRCacheEntry> | null
  issueCache?: Record<string, IssueCacheEntry> | null
  workspacePortsByWorktreeId?: ReadonlyMap<
    string,
    readonly { port: number; processName?: string }[]
  >
  checksReviewByWorktree?: ReadonlyMap<Worktree, HostedReviewInfo | null>
  hostLabelByWorktreeId?: ReadonlyMap<string, string>
  evidencePolicy?: WorktreePaletteEvidencePolicy
}

function resolveReviewSource(
  worktree: Worktree,
  repo: Repo | undefined,
  sources: WorktreePaletteDocumentSources
): WorktreePaletteReviewSource | null {
  const checksReview = sources.checksReviewByWorktree?.get(worktree)
  if (checksReview) {
    return checksReview
  }
  // Why: an explicit null entry means the hosted-review index already answered
  // for this worktree, so falling back to the raw caches would contradict it.
  if (checksReview === null) {
    return null
  }

  const branch = resolveWorktreeBranchLabel(worktree)
  const cached = repo && sources.prCache ? sources.prCache[`${repo.path}::${branch}`]?.data : null
  if (cached) {
    return { provider: 'github', number: cached.number, title: cached.title }
  }
  if (worktree.linkedPR != null) {
    return { provider: 'github', number: worktree.linkedPR }
  }
  if (worktree.linkedGitLabMR != null) {
    return { provider: 'gitlab', number: worktree.linkedGitLabMR }
  }
  return null
}

function resolveIssueTitle(
  worktree: Worktree,
  repo: Repo | undefined,
  sources: WorktreePaletteDocumentSources
): string {
  if (worktree.linkedIssue == null || !repo || !sources.issueCache) {
    return ''
  }
  const key = getIssueCacheKey(
    repo.path,
    repo.id,
    worktree.linkedIssue,
    undefined,
    repo.connectionId,
    repo.executionHostId
  )
  return sources.issueCache[key]?.data?.title ?? ''
}

function buildEvidence(
  worktree: Worktree,
  repo: Repo | undefined,
  sources: WorktreePaletteDocumentSources
): PaletteComposedEvidence[] {
  const comment = buildWorktreeCommentEvidence(worktree.comment ?? '')
  if (sources.evidencePolicy === 'board') {
    return comment ? [comment] : []
  }

  const ports = sources.workspacePortsByWorktreeId?.get(worktree.id) ?? []
  const units = [
    comment,
    buildWorktreeAutomationEvidence(worktree),
    buildWorktreeLinkedTaskEvidence(worktree),
    buildWorktreeReviewEvidence(resolveReviewSource(worktree, repo, sources)),
    buildWorktreeIssueEvidence({
      number: worktree.linkedIssue,
      title: resolveIssueTitle(worktree, repo, sources)
    }),
    ...ports.map((port) => buildWorktreePortEvidence(port))
  ]
  return units.filter((unit): unit is PaletteComposedEvidence => unit !== null)
}

export function buildWorktreePaletteDocument(
  worktree: Worktree,
  sources: WorktreePaletteDocumentSources
): PaletteDocument {
  const repo = resolvePaletteRepoForWorktree(
    worktree,
    sources.repoMap,
    sources.repoMapByHostIdentity
  )
  return buildPaletteDocument({
    id: worktree.id,
    visibleFields: [
      {
        id: WORKTREE_PALETTE_NAME_FIELD_ID,
        profile: 'structured-label',
        text: resolveWorktreeDisplayName(worktree)
      },
      {
        id: WORKTREE_PALETTE_BRANCH_FIELD_ID,
        profile: 'structured-label',
        text: resolveWorktreeBranchLabel(worktree)
      },
      {
        id: WORKTREE_PALETTE_REPO_FIELD_ID,
        profile: 'structured-label',
        text: repo?.displayName ?? ''
      },
      {
        id: WORKTREE_PALETTE_HOST_FIELD_ID,
        profile: 'structured-label',
        // Why conditional: the host chip only renders for active remote hosts, and
        // an unrendered match would be unexplainable on the row.
        // Why both keys: the palette keys this map by host identity so two same-id
        // workspaces keep distinct chips, but a bare-id map is still a valid input.
        text:
          sources.hostLabelByWorktreeId?.get(getWorktreeHostIdentity(worktree)) ??
          sources.hostLabelByWorktreeId?.get(worktree.id) ??
          ''
      }
    ],
    compositePairs: [
      {
        leftFieldId: WORKTREE_PALETTE_REPO_FIELD_ID,
        rightFieldId: WORKTREE_PALETTE_BRANCH_FIELD_ID
      },
      { leftFieldId: WORKTREE_PALETTE_REPO_FIELD_ID, rightFieldId: WORKTREE_PALETTE_NAME_FIELD_ID }
    ],
    evidence: buildEvidence(worktree, repo, sources)
  })
}

export function buildWorktreePaletteDocuments(
  worktrees: readonly Worktree[],
  sources: WorktreePaletteDocumentSources
): Map<string, PaletteDocument> {
  const documents = new Map<string, PaletteDocument>()
  for (const worktree of worktrees) {
    // Why the host identity (STA-4343): `repoId::path` repeats across hosts, so keying on
    // the bare id lets the second host overwrite the first and one workspace becomes
    // unsearchable by its own name.
    documents.set(
      getWorktreeHostIdentity(worktree),
      buildWorktreePaletteDocument(worktree, sources)
    )
  }
  return documents
}
