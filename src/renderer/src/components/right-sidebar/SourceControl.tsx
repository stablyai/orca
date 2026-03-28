import React, { useCallback, useMemo, useState } from 'react'
import {
  ChevronDown,
  Minus,
  Plus,
  Undo2,
  FileEdit,
  FilePlus,
  FileMinus,
  FileQuestion,
  ArrowRightLeft,
  GitCompareArrows
} from 'lucide-react'
import { useAppStore } from '@/store'
import { detectLanguage } from '@/lib/language-detect'
import { basename, dirname, joinPath } from '@/lib/path'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import type { GitStatusEntry, GitStagingArea } from '../../../../shared/types'
import { getSourceControlActions } from './source-control-actions'
import { STATUS_COLORS, STATUS_LABELS } from './status-display'

const STATUS_ICONS: Record<
  string,
  React.ComponentType<{ className?: string; style?: React.CSSProperties }>
> = {
  modified: FileEdit,
  added: FilePlus,
  deleted: FileMinus,
  renamed: ArrowRightLeft,
  untracked: FileQuestion,
  copied: FilePlus
}

const SECTION_ORDER: GitStagingArea[] = ['staged', 'unstaged', 'untracked']
const SECTION_LABELS: Record<GitStagingArea, string> = {
  staged: 'Staged Changes',
  unstaged: 'Changes',
  untracked: 'Untracked Files'
}

export default function SourceControl(): React.JSX.Element {
  const activeWorktreeId = useAppStore((s) => s.activeWorktreeId)
  const worktreesByRepo = useAppStore((s) => s.worktreesByRepo)
  const gitStatusByWorktree = useAppStore((s) => s.gitStatusByWorktree)
  const setGitStatus = useAppStore((s) => s.setGitStatus)
  const openDiff = useAppStore((s) => s.openDiff)
  const openAllDiffs = useAppStore((s) => s.openAllDiffs)

  const [collapsedSections, setCollapsedSections] = useState<Set<string>>(new Set())

  // Find active worktree path
  const worktreePath = useMemo(() => {
    if (!activeWorktreeId) {
      return null
    }
    for (const worktrees of Object.values(worktreesByRepo)) {
      const wt = worktrees.find((w) => w.id === activeWorktreeId)
      if (wt) {
        return wt.path
      }
    }
    return null
  }, [activeWorktreeId, worktreesByRepo])

  const fetchStatus = useCallback(async () => {
    if (!activeWorktreeId || !worktreePath) {
      return
    }
    try {
      const entries = (await window.api.git.status({ worktreePath })) as GitStatusEntry[]
      setGitStatus(activeWorktreeId, entries)
    } catch {
      // ignore
    }
  }, [activeWorktreeId, worktreePath, setGitStatus])

  const entries = useMemo(
    () => (activeWorktreeId ? (gitStatusByWorktree[activeWorktreeId] ?? []) : []),
    [activeWorktreeId, gitStatusByWorktree]
  )

  const grouped = useMemo(() => {
    const groups: Record<GitStagingArea, GitStatusEntry[]> = {
      staged: [],
      unstaged: [],
      untracked: []
    }
    for (const entry of entries) {
      groups[entry.area].push(entry)
    }
    return groups
  }, [entries])

  const toggleSection = useCallback((section: string) => {
    setCollapsedSections((prev) => {
      const next = new Set(prev)
      if (next.has(section)) {
        next.delete(section)
      } else {
        next.add(section)
      }
      return next
    })
  }, [])

  const handleStage = useCallback(
    async (filePath: string) => {
      if (!worktreePath) {
        return
      }
      try {
        await window.api.git.stage({ worktreePath, filePath })
        void fetchStatus()
      } catch {
        // ignore
      }
    },
    [worktreePath, fetchStatus]
  )

  const handleUnstage = useCallback(
    async (filePath: string) => {
      if (!worktreePath) {
        return
      }
      try {
        await window.api.git.unstage({ worktreePath, filePath })
        void fetchStatus()
      } catch {
        // ignore
      }
    },
    [worktreePath, fetchStatus]
  )

  const handleDiscard = useCallback(
    async (filePath: string) => {
      if (!worktreePath) {
        return
      }
      try {
        await window.api.git.discard({ worktreePath, filePath })
        void fetchStatus()
      } catch {
        // ignore
      }
    },
    [worktreePath, fetchStatus]
  )

  const handleViewAllChanges = useCallback(() => {
    if (!activeWorktreeId || !worktreePath) {
      return
    }
    openAllDiffs(activeWorktreeId, worktreePath)
  }, [activeWorktreeId, worktreePath, openAllDiffs])

  const handleOpenDiff = useCallback(
    (entry: GitStatusEntry) => {
      if (!activeWorktreeId) {
        return
      }
      const language = detectLanguage(entry.path)
      const absolutePath = worktreePath ? joinPath(worktreePath, entry.path) : entry.path
      openDiff(activeWorktreeId, absolutePath, entry.path, language, entry.area === 'staged')
    },
    [activeWorktreeId, worktreePath, openDiff]
  )

  if (!worktreePath) {
    return (
      <div className="flex items-center justify-center h-full text-[11px] text-muted-foreground px-4 text-center">
        Select a worktree to view changes
      </div>
    )
  }

  if (entries.length === 0) {
    return (
      <div className="flex items-center justify-center h-full text-[11px] text-muted-foreground">
        No changes detected
      </div>
    )
  }

  return (
    <div className="flex-1 overflow-auto scrollbar-sleek">
      {/* View All Changes button */}
      <Button
        type="button"
        variant="ghost"
        className="h-auto w-full justify-start rounded-none border-b border-border px-3 py-2 text-left text-[12px] font-medium"
        onClick={handleViewAllChanges}
      >
        <GitCompareArrows className="size-3.5 text-muted-foreground" />
        View All Changes
        <span className="text-[10px] font-medium bg-muted/60 rounded-full px-1.5 py-0.5 ml-auto text-muted-foreground">
          {entries.length}
        </span>
      </Button>

      {SECTION_ORDER.map((area) => {
        const items = grouped[area]
        if (items.length === 0) {
          return null
        }
        const isCollapsed = collapsedSections.has(area)

        return (
          <div key={area}>
            {/* Section header */}
            <Button
              type="button"
              variant="ghost"
              className="h-auto w-full justify-start px-3 py-1.5 text-left text-[11px] font-semibold uppercase tracking-wider text-muted-foreground"
              onClick={() => toggleSection(area)}
            >
              <ChevronDown
                className={cn('size-3 transition-transform', isCollapsed && '-rotate-90')}
              />
              <span className="flex-1">{SECTION_LABELS[area]}</span>
              <span className="text-[10px] font-medium bg-muted/60 rounded-full px-1.5 py-0.5">
                {items.length}
              </span>
            </Button>

            {/* File entries */}
            {!isCollapsed &&
              items.map((entry) => {
                const StatusIcon = STATUS_ICONS[entry.status] ?? FileQuestion
                const fileName = basename(entry.path)
                const parentDir = dirname(entry.path)
                const dirPath = parentDir === '.' ? '' : parentDir
                const actions = getSourceControlActions(area)

                return (
                  <div
                    key={`${area}:${entry.path}`}
                    className="group flex items-center gap-1 px-3 py-0.5 hover:bg-accent/40 transition-colors cursor-pointer"
                    onClick={() => handleOpenDiff(entry)}
                  >
                    <StatusIcon
                      className="size-3.5 shrink-0"
                      style={{ color: STATUS_COLORS[entry.status] }}
                    />
                    <span className="truncate text-[12px] flex-1 min-w-0">
                      <span className="text-foreground">{fileName}</span>
                      {dirPath && (
                        <span className="text-muted-foreground ml-1.5 text-[11px]">{dirPath}</span>
                      )}
                    </span>
                    <span
                      className="text-[10px] font-bold shrink-0 w-4 text-center"
                      style={{ color: STATUS_COLORS[entry.status] }}
                    >
                      {STATUS_LABELS[entry.status]}
                    </span>

                    {/* Action buttons */}
                    <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity shrink-0">
                      {actions.includes('discard') && (
                        <ActionButton
                          icon={Undo2}
                          title={area === 'untracked' ? 'Revert untracked file' : 'Discard changes'}
                          onClick={(e) => {
                            e.stopPropagation()
                            if (area === 'untracked') {
                              if (
                                !window.confirm(
                                  `Delete untracked file "${entry.path}"? This cannot be undone.`
                                )
                              ) {
                                return
                              }
                            }
                            void handleDiscard(entry.path)
                          }}
                        />
                      )}
                      {actions.includes('stage') && (
                        <ActionButton
                          icon={Plus}
                          title="Stage"
                          onClick={(e) => {
                            e.stopPropagation()
                            void handleStage(entry.path)
                          }}
                        />
                      )}
                      {actions.includes('unstage') && (
                        <ActionButton
                          icon={Minus}
                          title="Unstage"
                          onClick={(e) => {
                            e.stopPropagation()
                            void handleUnstage(entry.path)
                          }}
                        />
                      )}
                    </div>
                  </div>
                )
              })}
          </div>
        )
      })}
    </div>
  )
}

function ActionButton({
  icon: Icon,
  title,
  onClick
}: {
  icon: React.ComponentType<{ className?: string }>
  title: string
  onClick: (e: React.MouseEvent) => void
}): React.JSX.Element {
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon-xs"
      className="h-auto w-auto p-0.5 text-muted-foreground hover:text-foreground"
      title={title}
      onClick={onClick}
    >
      <Icon className="size-3" />
    </Button>
  )
}
