/* oxlint-disable max-lines */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
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
import StatusIndicator from '@/components/sidebar/StatusIndicator'
import { cn } from '@/lib/utils'
import { getWorktreeStatus, getWorktreeStatusLabel } from '@/lib/worktree-status'
import { activateAndRevealWorktree } from '@/lib/worktree-activation'
import { findWorktreeById } from '@/store/slices/worktree-helpers'
import { searchWorktrees, type MatchRange } from '@/lib/worktree-palette-search'
import type { Worktree } from '../../../shared/types'

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

function PaletteState({ title, subtitle }: { title: string; subtitle: string }): React.JSX.Element {
  return (
    <div className="px-5 py-8 text-center">
      <p className="text-sm font-medium text-foreground">{title}</p>
      <p className="mt-1 text-xs text-muted-foreground">{subtitle}</p>
    </div>
  )
}

function FooterKey({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <span className="rounded-full border border-border/60 bg-muted/35 px-2 py-0.5 text-[10px] font-medium text-foreground/85">
      {children}
    </span>
  )
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
  const browserTabsByWorktree = useAppStore((s) => s.browserTabsByWorktree)

  const [query, setQuery] = useState('')
  const [selectedWorktreeId, setSelectedWorktreeId] = useState('')
  const previousWorktreeIdRef = useRef<string | null>(null)
  const wasVisibleRef = useRef(false)

  const repoMap = useMemo(() => new Map(repos.map((r) => [r.id, r])), [repos])

  // All non-archived worktrees sorted by recent signals
  const sortedWorktrees = useMemo(() => {
    const all: Worktree[] = Object.values(worktreesByRepo)
      .flat()
      .filter((w) => !w.isArchived)
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
  const isLoading = repos.length > 0 && Object.keys(worktreesByRepo).length === 0

  useEffect(() => {
    if (visible && !wasVisibleRef.current) {
      // Why: this dialog opens from external store state, so session reset must
      // follow the controlled `visible` flag instead of relying on Radix open callbacks.
      previousWorktreeIdRef.current = activeWorktreeId
      setQuery('')
      setSelectedWorktreeId('')
    }

    wasVisibleRef.current = visible
  }, [visible, activeWorktreeId])

  useEffect(() => {
    if (!visible) {
      return
    }
    if (matches.length === 0) {
      setSelectedWorktreeId('')
      return
    }
    if (!matches.some((match) => match.worktreeId === selectedWorktreeId)) {
      // Why: the palette keeps live recent ordering while open. Control cmdk's
      // selected value by worktree ID so background re-sorts keep the same
      // logical worktree selected instead of drifting to a new visual index.
      setSelectedWorktreeId(matches[0].worktreeId)
    }
  }, [visible, matches, selectedWorktreeId])

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

  const handleOpenChange = useCallback(
    (open: boolean) => {
      if (open) {
        return
      }

      closeModal()
      if (previousWorktreeIdRef.current) {
        focusActiveSurface()
      }
    },
    [closeModal, focusActiveSurface]
  )

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
      setSelectedWorktreeId('')
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
      overlayClassName="bg-black/55 backdrop-blur-[2px]"
      contentClassName="top-[13%] w-[736px] max-w-[94vw] overflow-hidden rounded-[22px] border border-border/70 bg-background/96 shadow-[0_26px_84px_rgba(0,0,0,0.32)] backdrop-blur-xl"
      commandProps={{
        loop: true,
        value: selectedWorktreeId,
        onValueChange: setSelectedWorktreeId,
        className: 'bg-transparent'
      }}
    >
      <CommandInput
        placeholder="Jump to worktree..."
        value={query}
        onValueChange={setQuery}
        wrapperClassName="mx-3 mt-3 rounded-[16px] border border-border/55 bg-muted/28 px-3.5 shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]"
        iconClassName="mr-2.5 h-4 w-4 text-muted-foreground/60"
        className="h-12 text-[14px] placeholder:text-muted-foreground/75"
      />
      <CommandList className="max-h-[min(460px,62vh)] px-2.5 pb-2.5 pt-1.5">
        {isLoading ? (
          <PaletteState
            title="Loading worktrees"
            subtitle="Gathering your recent worktrees and activity state."
          />
        ) : !hasWorktrees ? (
          <CommandEmpty className="py-0">
            <PaletteState
              title="No active worktrees"
              subtitle="Create one to get started, then jump back here any time."
            />
          </CommandEmpty>
        ) : matches.length === 0 ? (
          <CommandEmpty className="py-0">
            <PaletteState
              title="No worktrees match your search"
              subtitle="Try a name, branch, repo, comment, PR, or issue."
            />
          </CommandEmpty>
        ) : (
          matches.map((match) => {
            const w = worktreeMap.get(match.worktreeId)
            if (!w) {
              return null
            }
            const repo = repoMap.get(w.repoId)
            const repoName = repo?.displayName ?? ''
            const branch = branchName(w.branch)
            const status = getWorktreeStatus(
              tabsByWorktree[w.id] ?? [],
              browserTabsByWorktree[w.id] ?? []
            )
            const statusLabel = getWorktreeStatusLabel(status)
            const isCurrentWorktree = activeWorktreeId === w.id

            return (
              <CommandItem
                key={w.id}
                value={w.id}
                onSelect={() => handleSelect(w.id)}
                data-current={isCurrentWorktree ? 'true' : undefined}
                className={cn(
                  'mx-0.5 flex items-start gap-3 rounded-[14px] border border-transparent px-3 py-2.5 text-left outline-none transition-[background-color,border-color,box-shadow]',
                  'data-[selected=true]:border-border/70 data-[selected=true]:bg-accent/55 data-[selected=true]:text-foreground data-[selected=true]:shadow-[inset_0_0_0_1px_rgba(255,255,255,0.03)]',
                  'data-[current=true]:border-emerald-500/25 data-[current=true]:bg-emerald-500/[0.05]'
                )}
              >
                <div className="mt-0.5 flex w-7 shrink-0 items-start justify-center">
                  <div className="flex h-7 w-7 items-center justify-center rounded-full border border-border/45 bg-muted/35">
                    <StatusIndicator status={status} aria-hidden="true" />
                    <span className="sr-only">{statusLabel}</span>
                  </div>
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-start justify-between gap-2.5">
                    <div className="min-w-0">
                      <div className="flex min-w-0 items-center gap-2">
                        <span className="truncate text-[14px] font-semibold tracking-[-0.01em] text-foreground">
                          {match.displayNameRange ? (
                            <HighlightedText
                              text={w.displayName}
                              matchRange={match.displayNameRange}
                            />
                          ) : (
                            w.displayName
                          )}
                        </span>
                        {isCurrentWorktree && (
                          <span className="shrink-0 rounded-[6px] border border-border/60 bg-background/45 px-1.5 py-0.5 text-[9px] font-medium leading-none text-muted-foreground/88 shadow-[inset_0_1px_0_rgba(255,255,255,0.02)]">
                            Current
                          </span>
                        )}
                      </div>
                      <div className="mt-1 flex min-w-0 items-center gap-1.5 text-[12px] text-muted-foreground">
                        <span className="truncate font-medium text-muted-foreground/92">
                          {match.branchRange ? (
                            <HighlightedText text={branch} matchRange={match.branchRange} />
                          ) : (
                            branch
                          )}
                        </span>
                      </div>
                      {match.supportingText && (
                        <div className="mt-1.5 flex min-w-0 items-start gap-2 text-[12px] leading-5 text-muted-foreground/88">
                          <span className="shrink-0 rounded-full border border-border/45 bg-background/45 px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-[0.12em] text-muted-foreground/75">
                            {match.supportingText.label}
                          </span>
                          <span className="truncate">
                            <HighlightedText
                              text={match.supportingText.text}
                              matchRange={match.supportingText.matchRange}
                            />
                          </span>
                        </div>
                      )}
                    </div>
                    <div className="flex shrink-0 flex-col items-end gap-1.5 pt-0.5">
                      {repoName && (
                        <span className="inline-flex max-w-[180px] items-center gap-1.5 rounded-[7px] border border-border/55 bg-muted/38 px-2 py-1 text-[10px] font-semibold leading-none text-foreground/92 shadow-[inset_0_1px_0_rgba(255,255,255,0.02)]">
                          <span
                            aria-hidden="true"
                            className="size-1.5 shrink-0 rounded-full"
                            style={
                              repo?.badgeColor ? { backgroundColor: repo.badgeColor } : undefined
                            }
                          />
                          <span className="truncate">
                            {match.repoRange ? (
                              <HighlightedText text={repoName} matchRange={match.repoRange} />
                            ) : (
                              repoName
                            )}
                          </span>
                        </span>
                      )}
                      {match.badgeLabel && (
                        <span
                          className="rounded-full border border-border/40 bg-background/45 px-2 py-0.5 text-[9px] font-medium uppercase tracking-[0.12em] text-muted-foreground/82"
                          aria-label={`Matched in ${match.badgeLabel}`}
                        >
                          {match.badgeLabel}
                        </span>
                      )}
                    </div>
                  </div>
                </div>
              </CommandItem>
            )
          })
        )}
      </CommandList>
      <div className="flex items-center justify-end border-t border-border/60 px-3.5 py-2.5 text-[11px] text-muted-foreground/82">
        <div className="flex items-center gap-2">
          <FooterKey>Enter</FooterKey>
          <span>Jump</span>
          <FooterKey>Esc</FooterKey>
          <span>Close</span>
          <FooterKey>↑↓</FooterKey>
          <span>Move</span>
        </div>
      </div>
      {/* Accessibility: announce result count changes */}
      <div aria-live="polite" className="sr-only">
        {query.trim() ? `${resultCount} worktrees found` : `${resultCount} worktrees available`}
      </div>
    </CommandDialog>
  )
}
