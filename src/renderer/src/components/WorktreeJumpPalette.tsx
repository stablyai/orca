/* oxlint-disable max-lines */
import React, { useCallback, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import { useAppStore } from '@/store'
import {
  CommandDialog,
  CommandInput,
  CommandList,
  CommandEmpty,
  CommandItem
} from '@/components/ui/command'
import { branchName } from '@/lib/git-utils'
import { sortWorktreesRecent } from '@/components/sidebar/smart-sort'
import { activateAndRevealWorktree } from '@/lib/worktree-activation'
import { findWorktreeById } from '@/store/slices/worktree-helpers'
import type { Worktree, Repo } from '../../../shared/types'

// ─── Search result types ────────────────────────────────────────────

type MatchRange = { start: number; end: number }

type PaletteMatchBase = { worktreeId: string }

/** Empty query — all non-archived worktrees shown, no match metadata. */
type PaletteMatchAll = PaletteMatchBase & {
  matchedField: null
  matchRange: null
}

/** Comment match — includes a truncated snippet centered on the matched range. */
type PaletteMatchComment = PaletteMatchBase & {
  matchedField: 'comment'
  matchRange: MatchRange
  snippet: string
  /** Offset of the snippet start within the original comment, for highlight calculation. */
  snippetOffset: number
}

/** Non-comment field match — range within the matched field's display value. */
type PaletteMatchField = PaletteMatchBase & {
  matchedField: 'displayName' | 'branch' | 'repo' | 'pr' | 'issue'
  matchRange: MatchRange
}

type PaletteMatch = PaletteMatchAll | PaletteMatchComment | PaletteMatchField

// ─── Search logic ───────────────────────────────────────────────────

function extractCommentSnippet(
  comment: string,
  matchStart: number,
  matchEnd: number
): { snippet: string; snippetOffset: number } {
  let snippetStart = Math.max(0, matchStart - 40)
  let snippetEnd = Math.min(comment.length, matchEnd + 40)

  // Snap to word boundaries (scan up to 10 chars)
  for (let i = 0; i < 10 && snippetStart > 0; i++) {
    if (/\s/.test(comment[snippetStart - 1])) {
      break
    }
    snippetStart--
  }
  for (let i = 0; i < 10 && snippetEnd < comment.length; i++) {
    if (/\s/.test(comment[snippetEnd])) {
      break
    }
    snippetEnd++
  }

  const prefix = snippetStart > 0 ? '\u2026' : ''
  const suffix = snippetEnd < comment.length ? '\u2026' : ''
  const snippet = prefix + comment.slice(snippetStart, snippetEnd) + suffix

  return { snippet, snippetOffset: snippetStart - prefix.length }
}

function searchWorktrees(
  worktrees: Worktree[],
  query: string,
  repoMap: Map<string, Repo>,
  prCache: Record<string, { data?: { number: number; title: string } | null }> | null,
  issueCache: Record<string, { data?: { number: number; title: string } | null }> | null
): PaletteMatch[] {
  if (!query) {
    return worktrees.map((w) => ({
      worktreeId: w.id,
      matchedField: null,
      matchRange: null
    }))
  }

  const q = query.toLowerCase()
  const results: PaletteMatch[] = []

  for (const w of worktrees) {
    // Field priority: displayName > branch > repo > comment > pr > issue
    const nameIdx = w.displayName.toLowerCase().indexOf(q)
    if (nameIdx !== -1) {
      results.push({
        worktreeId: w.id,
        matchedField: 'displayName',
        matchRange: { start: nameIdx, end: nameIdx + q.length }
      })
      continue
    }

    const branch = branchName(w.branch)
    const branchIdx = branch.toLowerCase().indexOf(q)
    if (branchIdx !== -1) {
      results.push({
        worktreeId: w.id,
        matchedField: 'branch',
        matchRange: { start: branchIdx, end: branchIdx + q.length }
      })
      continue
    }

    const repoName = repoMap.get(w.repoId)?.displayName ?? ''
    const repoIdx = repoName.toLowerCase().indexOf(q)
    if (repoIdx !== -1) {
      results.push({
        worktreeId: w.id,
        matchedField: 'repo',
        matchRange: { start: repoIdx, end: repoIdx + q.length }
      })
      continue
    }

    if (w.comment) {
      const commentIdx = w.comment.toLowerCase().indexOf(q)
      if (commentIdx !== -1) {
        const { snippet, snippetOffset } = extractCommentSnippet(
          w.comment,
          commentIdx,
          commentIdx + q.length
        )
        results.push({
          worktreeId: w.id,
          matchedField: 'comment',
          matchRange: { start: commentIdx, end: commentIdx + q.length },
          snippet,
          snippetOffset
        })
        continue
      }
    }

    // Strip leading '#' for number matching, guard against bare '#'
    const numQuery = q.startsWith('#') ? q.slice(1) : q
    if (!numQuery) {
      continue
    }

    // PR matching
    const repo = repoMap.get(w.repoId)
    const branchForPR = branchName(w.branch)
    const prKey = repo && branchForPR ? `${repo.path}::${branchForPR}` : ''
    const pr = prKey && prCache ? prCache[prKey]?.data : undefined

    if (pr) {
      const prNumStr = String(pr.number)
      const prNumIdx = prNumStr.indexOf(numQuery)
      if (prNumIdx !== -1) {
        results.push({
          worktreeId: w.id,
          matchedField: 'pr',
          matchRange: { start: prNumIdx, end: prNumIdx + numQuery.length }
        })
        continue
      }
      const prTitleIdx = pr.title.toLowerCase().indexOf(q)
      if (prTitleIdx !== -1) {
        results.push({
          worktreeId: w.id,
          matchedField: 'pr',
          matchRange: { start: prTitleIdx, end: prTitleIdx + q.length }
        })
        continue
      }
    } else if (w.linkedPR != null) {
      const prNumStr = String(w.linkedPR)
      const prNumIdx = prNumStr.indexOf(numQuery)
      if (prNumIdx !== -1) {
        results.push({
          worktreeId: w.id,
          matchedField: 'pr',
          matchRange: { start: prNumIdx, end: prNumIdx + numQuery.length }
        })
        continue
      }
    }

    // Issue matching
    if (w.linkedIssue != null) {
      const issueNumStr = String(w.linkedIssue)
      const issueNumIdx = issueNumStr.indexOf(numQuery)
      if (issueNumIdx !== -1) {
        results.push({
          worktreeId: w.id,
          matchedField: 'issue',
          matchRange: { start: issueNumIdx, end: issueNumIdx + numQuery.length }
        })
        continue
      }
      const issueKey = repo ? `${repo.path}::${w.linkedIssue}` : ''
      const issue = issueKey && issueCache ? issueCache[issueKey]?.data : undefined
      if (issue?.title) {
        const issueTitleIdx = issue.title.toLowerCase().indexOf(q)
        if (issueTitleIdx !== -1) {
          results.push({
            worktreeId: w.id,
            matchedField: 'issue',
            matchRange: { start: issueTitleIdx, end: issueTitleIdx + q.length }
          })
          continue
        }
      }
    }
  }

  return results
}

// ─── Highlight helper ───────────────────────────────────────────────

function HighlightedText({
  text,
  matchRange
}: {
  text: string
  matchRange: MatchRange | null
}): React.JSX.Element {
  if (!matchRange) {
    return <>{text}</>
  }
  const before = text.slice(0, matchRange.start)
  const match = text.slice(matchRange.start, matchRange.end)
  const after = text.slice(matchRange.end)
  return (
    <>
      {before}
      <span className="font-semibold text-foreground">{match}</span>
      {after}
    </>
  )
}

// ─── Field badge labels ─────────────────────────────────────────────

const FIELD_BADGES: Record<string, string> = {
  branch: 'Branch',
  repo: 'Repo',
  comment: 'Comment',
  pr: 'PR',
  issue: 'Issue'
}

// ─── Component ──────────────────────────────────────────────────────

export default function WorktreeJumpPalette(): React.JSX.Element | null {
  const visible = useAppStore((s) => s.activeModal === 'worktree-palette')
  const closeModal = useAppStore((s) => s.closeModal)
  const worktreesByRepo = useAppStore((s) => s.worktreesByRepo)
  const repos = useAppStore((s) => s.repos)
  const tabsByWorktree = useAppStore((s) => s.tabsByWorktree)
  const prCache = useAppStore((s) => s.prCache)
  const issueCache = useAppStore((s) => s.issueCache)
  const activeWorktreeId = useAppStore((s) => s.activeWorktreeId)

  const [query, setQuery] = useState('')
  const previousWorktreeIdRef = useRef<string | null>(null)

  const repoMap = useMemo(() => new Map(repos.map((r) => [r.id, r])), [repos])

  // All non-archived worktrees sorted by recent signals
  const sortedWorktrees = useMemo(() => {
    const all: Worktree[] = Object.values(worktreesByRepo).flat().filter((w) => !w.isArchived)
    return sortWorktreesRecent(all, tabsByWorktree, repoMap, prCache)
  }, [worktreesByRepo, tabsByWorktree, repoMap, prCache])

  // Search results
  const matches = useMemo(
    () => searchWorktrees(sortedWorktrees, query.trim(), repoMap, prCache, issueCache),
    [sortedWorktrees, query, repoMap, prCache, issueCache]
  )

  // Build a map of worktreeId -> Worktree for quick lookup
  const worktreeMap = useMemo(() => {
    const map = new Map<string, Worktree>()
    for (const w of sortedWorktrees) {
      map.set(w.id, w)
    }
    return map
  }, [sortedWorktrees])

  // Loading state: repos exist but worktreesByRepo is still empty
  const isLoading =
    repos.length > 0 && Object.keys(worktreesByRepo).length === 0

  const handleOpenChange = useCallback(
    (open: boolean) => {
      if (open) {
        previousWorktreeIdRef.current = activeWorktreeId
        setQuery('')
      } else {
        closeModal()
      }
    },
    [closeModal, activeWorktreeId]
  )

  const focusActiveSurface = useCallback(() => {
    // Why: double rAF — first waits for React to commit state (palette closes),
    // second waits for the target worktree surface layout to settle after Radix
    // Dialog unmounts. Pragmatic v1 choice per design doc Section 3.5.
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        const xterm = document.querySelector('.xterm-helper-textarea') as HTMLElement | null
        if (xterm) {
          xterm.focus()
          return
        }
        // Fallback: try Monaco editor
        const monaco = document.querySelector('.monaco-editor textarea') as HTMLElement | null
        if (monaco) {
          monaco.focus()
        }
      })
    })
  }, [])

  const handleSelect = useCallback(
    (worktreeId: string) => {
      const state = useAppStore.getState()
      const wt = findWorktreeById(state.worktreesByRepo, worktreeId)
      if (!wt) {
        toast.error('Worktree no longer exists')
        return
      }
      activateAndRevealWorktree(worktreeId)
      closeModal()
      focusActiveSurface()
    },
    [closeModal, focusActiveSurface]
  )

  const handleCloseAutoFocus = useCallback((e: Event) => {
    // Why: prevent Radix from stealing focus to the trigger element. We manage
    // focus ourselves via the double-rAF approach.
    e.preventDefault()
  }, [])

  // Result count for screen readers
  const resultCount = matches.length
  const hasWorktrees = sortedWorktrees.length > 0

  return (
    <CommandDialog
      open={visible}
      onOpenChange={handleOpenChange}
      shouldFilter={false}
      onCloseAutoFocus={handleCloseAutoFocus}
      title="Open Worktree"
      description="Search across all worktrees by name, branch, comment, PR, or issue"
    >
      <CommandInput
        placeholder="Jump to worktree..."
        value={query}
        onValueChange={setQuery}
      />
      <CommandList>
        {isLoading ? (
          <div className="py-6 text-center text-sm text-muted-foreground">
            Loading worktrees...
          </div>
        ) : !hasWorktrees ? (
          <CommandEmpty>No active worktrees. Create one to get started.</CommandEmpty>
        ) : matches.length === 0 ? (
          <CommandEmpty>No worktrees match your search.</CommandEmpty>
        ) : (
          matches.map((match) => {
            const w = worktreeMap.get(match.worktreeId)
            if (!w) {
              return null
            }
            const repo = repoMap.get(w.repoId)
            const repoName = repo?.displayName ?? ''
            const branch = branchName(w.branch)

            return (
              <CommandItem
                key={w.id}
                value={w.id}
                onSelect={() => handleSelect(w.id)}
                className="flex items-center gap-2 px-3 py-2"
              >
                <div className="flex flex-col min-w-0 flex-1 gap-0.5">
                  <div className="flex items-center gap-2 min-w-0">
                    <span className="truncate text-sm font-medium text-foreground">
                      {match.matchedField === 'displayName' ? (
                        <HighlightedText
                          text={w.displayName}
                          matchRange={match.matchRange}
                        />
                      ) : (
                        w.displayName
                      )}
                    </span>
                    {/* Repo badge for multi-repo disambiguation */}
                    {repoName && (
                      <span
                        className="shrink-0 rounded px-1.5 py-0.5 text-[10px] leading-none text-muted-foreground bg-muted"
                        style={
                          repo?.badgeColor
                            ? {
                                backgroundColor: `${repo.badgeColor}15`,
                                color: repo.badgeColor
                              }
                            : undefined
                        }
                      >
                        {match.matchedField === 'repo' ? (
                          <HighlightedText
                            text={repoName}
                            matchRange={match.matchRange}
                          />
                        ) : (
                          repoName
                        )}
                      </span>
                    )}
                    {/* Match-field badge */}
                    {match.matchedField && FIELD_BADGES[match.matchedField] && (
                      <span
                        className="shrink-0 rounded px-1 py-0.5 text-[10px] leading-none text-muted-foreground/70 border border-border/50"
                        aria-label={`Matched in ${FIELD_BADGES[match.matchedField]}`}
                      >
                        {FIELD_BADGES[match.matchedField]}
                      </span>
                    )}
                  </div>
                  {/* Secondary info: branch + optional match snippet */}
                  <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground truncate">
                    <span className="truncate">
                      {match.matchedField === 'branch' ? (
                        <HighlightedText text={branch} matchRange={match.matchRange} />
                      ) : (
                        branch
                      )}
                    </span>
                    {match.matchedField === 'comment' && 'snippet' in match && (
                      <>
                        <span className="text-border">|</span>
                        <span className="truncate italic">
                          <HighlightedText
                            text={match.snippet}
                            matchRange={{
                              start: match.matchRange.start - match.snippetOffset,
                              end: match.matchRange.end - match.snippetOffset
                            }}
                          />
                        </span>
                      </>
                    )}
                    {match.matchedField === 'pr' && (
                      <>
                        <span className="text-border">|</span>
                        <span className="truncate">PR #{w.linkedPR}</span>
                      </>
                    )}
                    {match.matchedField === 'issue' && (
                      <>
                        <span className="text-border">|</span>
                        <span className="truncate">Issue #{w.linkedIssue}</span>
                      </>
                    )}
                  </div>
                </div>
              </CommandItem>
            )
          })
        )}
      </CommandList>
      {/* Accessibility: announce result count changes */}
      <div aria-live="polite" className="sr-only">
        {query.trim() ? `${resultCount} worktrees found` : ''}
      </div>
    </CommandDialog>
  )
}
