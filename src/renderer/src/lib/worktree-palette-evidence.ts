import {
  composePaletteEvidence,
  type PaletteComposedEvidence
} from './palette-match/evidence-composer'
import { extractWorktreePaletteCommentSnippet } from './worktree-palette-comment-snippet'
import type { MatchRange } from './palette-match/normalized-text'
import type { HostedReviewInfo } from '../../../shared/hosted-review'
import type { Worktree } from '../../../shared/worktree/types'

/** Chip label kinds the worktree row can render for a supporting-evidence unit. */
export type PaletteSupportingKind =
  | 'comment'
  | 'pr'
  | 'mr'
  | 'issue'
  | 'port'
  | 'task'
  | 'automation'

export type WorktreePaletteReviewSource = {
  provider: HostedReviewInfo['provider']
  number: number
  title?: string
}

function toIsoDate(epochMs: number | undefined): string {
  if (!epochMs || !Number.isFinite(epochMs)) {
    return ''
  }
  const date = new Date(epochMs)
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${date.getFullYear()}-${month}-${day}`
}

export function buildWorktreeCommentEvidence(comment: string): PaletteComposedEvidence | null {
  return composePaletteEvidence({
    id: 'comment',
    kind: 'comment',
    accessibilityLabel: 'Workspace comment',
    parts: [{ key: 'text', text: comment, profile: 'prose' }]
  })
}

/** Comments are indexed whole, then narrowed to a snippet around what matched. */
export function applyWorktreeCommentSnippet(
  comment: string,
  ranges: readonly MatchRange[]
): { text: string; ranges: readonly MatchRange[] } {
  if (!ranges.length) {
    return { text: comment, ranges }
  }
  const start = Math.min(...ranges.map((range) => range.start))
  const end = Math.max(...ranges.map((range) => range.end))
  const snippet = extractWorktreePaletteCommentSnippet(comment, start, end)
  const delta = snippet.matchRange.start - start
  const shifted = ranges
    .map((range) => ({ start: range.start + delta, end: range.end + delta }))
    .filter((range) => range.start >= 0 && range.end <= snippet.text.length)
  return { text: snippet.text, ranges: shifted.length ? shifted : [snippet.matchRange] }
}

export function buildWorktreeAutomationEvidence(
  worktree: Worktree
): PaletteComposedEvidence | null {
  const provenance = worktree.automationProvenance
  if (!provenance) {
    return null
  }
  return composePaletteEvidence({
    id: `automation:${provenance.automationRunId || provenance.automationId}`,
    kind: 'automation',
    accessibilityLabel: 'Created by automation',
    parts: [
      { key: 'name', text: provenance.automationNameSnapshot, profile: 'structured-label' },
      {
        key: 'run-title',
        text: provenance.automationRunTitleSnapshot,
        profile: 'structured-label'
      },
      {
        key: 'run-id',
        text: provenance.automationRunId,
        profile: 'identifier',
        identifier: { kind: 'key' }
      },
      {
        key: 'created',
        text: toIsoDate(provenance.createdAt),
        profile: 'identifier',
        identifier: { kind: 'date' }
      }
    ]
  })
}

function resolveLinkedTaskIdentifier(worktree: Worktree): string {
  const item = worktree.linkedWorkItem
  if (item?.linearIdentifier) {
    return item.linearIdentifier
  }
  if (item?.jiraIdentifier) {
    return item.jiraIdentifier
  }
  if (item && item.number > 0) {
    return `#${item.number}`
  }
  return worktree.linkedLinearIssue ?? ''
}

/**
 * Provider-neutral linked task. `linkedWorkItem` is authoritative; the legacy
 * Linear identifier is the fallback when no work item was persisted.
 */
export function buildWorktreeLinkedTaskEvidence(
  worktree: Worktree
): PaletteComposedEvidence | null {
  const identifier = resolveLinkedTaskIdentifier(worktree)
  const title = worktree.linkedWorkItem?.title ?? ''
  if (!identifier && !title) {
    return null
  }
  return composePaletteEvidence({
    id: `task:${identifier || title}`,
    kind: 'task',
    accessibilityLabel: 'Linked task',
    parts: [
      {
        key: 'identifier',
        text: identifier,
        profile: 'identifier',
        identifier: { kind: 'key' }
      },
      { key: 'title', text: title, profile: 'prose' }
    ]
  })
}

export function buildWorktreeReviewEvidence(
  review: WorktreePaletteReviewSource | null | undefined
): PaletteComposedEvidence | null {
  if (!review || !Number.isFinite(review.number)) {
    return null
  }
  const isMergeRequest = review.provider === 'gitlab'
  const sigil = isMergeRequest ? '!' : '#'
  return composePaletteEvidence({
    id: `review:${review.provider}:${review.number}`,
    kind: isMergeRequest ? 'mr' : 'pr',
    accessibilityLabel: isMergeRequest ? 'Merge request' : 'Pull request',
    parts: [
      {
        key: 'number',
        text: `${sigil}${review.number}`,
        profile: 'identifier',
        identifier: { kind: 'number', sigil }
      },
      { key: 'title', text: review.title ?? '', profile: 'prose' }
    ]
  })
}

export function buildWorktreeIssueEvidence(args: {
  number: number | null | undefined
  title?: string
}): PaletteComposedEvidence | null {
  if (args.number == null || !Number.isFinite(args.number)) {
    return null
  }
  return composePaletteEvidence({
    id: `issue:${args.number}`,
    kind: 'issue',
    accessibilityLabel: 'Linked issue',
    parts: [
      {
        key: 'number',
        text: `#${args.number}`,
        profile: 'identifier',
        identifier: { kind: 'number', sigil: '#' }
      },
      { key: 'title', text: args.title ?? '', profile: 'prose' }
    ]
  })
}

export function buildWorktreePortEvidence(
  port: Readonly<{ port: number; processName?: string }>
): PaletteComposedEvidence | null {
  return composePaletteEvidence({
    id: `port:${port.port}`,
    kind: 'port',
    accessibilityLabel: 'Listening port',
    parts: [
      {
        key: 'number',
        text: String(port.port),
        profile: 'identifier',
        identifier: { kind: 'port' }
      },
      { key: 'process', text: port.processName ?? '', profile: 'structured-label' }
    ]
  })
}
