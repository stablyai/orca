import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
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
import { cn } from '@/lib/utils'
import type { GitStatusEntry, GitStagingArea } from '../../../../shared/types'

const STATUS_ICONS: Record<string, React.ComponentType<{ className?: string }>> = {
  modified: FileEdit,
  added: FilePlus,
  deleted: FileMinus,
  renamed: ArrowRightLeft,
  untracked: FileQuestion,
  copied: FilePlus
}

const STATUS_LABELS: Record<string, string> = {
  modified: 'M',
  added: 'A',
  deleted: 'D',
  renamed: 'R',
  untracked: 'U',
  copied: 'C'
}

const STATUS_COLORS: Record<string, string> = {
  modified: 'text-amber-500',
  added: 'text-green-500',
  deleted: 'text-red-500',
  renamed: 'text-blue-500',
  untracked: 'text-green-600',
  copied: 'text-blue-400'
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
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)

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

  // Poll git status every 3 seconds
  useEffect(() => {
    void fetchStatus()
    pollRef.current = setInterval(() => void fetchStatus(), 3000)
    return () => {
      if (pollRef.current) {
        clearInterval(pollRef.current)
      }
    }
  }, [fetchStatus])

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
      const absolutePath = worktreePath ? `${worktreePath}/${entry.path}` : entry.path
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
      <button
        className="flex items-center gap-1.5 w-full px-3 py-2 text-left text-[12px] font-medium text-foreground hover:bg-accent/40 transition-colors border-b border-border"
        onClick={handleViewAllChanges}
      >
        <GitCompareArrows className="size-3.5 text-muted-foreground" />
        View All Changes
        <span className="text-[10px] font-medium bg-muted/60 rounded-full px-1.5 py-0.5 ml-auto text-muted-foreground">
          {entries.length}
        </span>
      </button>

      {SECTION_ORDER.map((area) => {
        const items = grouped[area]
        if (items.length === 0) {
          return null
        }
        const isCollapsed = collapsedSections.has(area)

        return (
          <div key={area}>
            {/* Section header */}
            <button
              className="flex items-center gap-1.5 w-full px-3 py-1.5 text-left text-[11px] font-semibold uppercase tracking-wider text-muted-foreground hover:bg-accent/40 transition-colors"
              onClick={() => toggleSection(area)}
            >
              <ChevronDown
                className={cn('size-3 transition-transform', isCollapsed && '-rotate-90')}
              />
              <span className="flex-1">{SECTION_LABELS[area]}</span>
              <span className="text-[10px] font-medium bg-muted/60 rounded-full px-1.5 py-0.5">
                {items.length}
              </span>
            </button>

            {/* File entries */}
            {!isCollapsed &&
              items.map((entry) => {
                const StatusIcon = STATUS_ICONS[entry.status] ?? FileQuestion
                const fileName = entry.path.split('/').pop() ?? entry.path
                const dirPath = entry.path.includes('/')
                  ? entry.path.slice(0, entry.path.lastIndexOf('/'))
                  : ''

                return (
                  <div
                    key={`${area}:${entry.path}`}
                    className="group flex items-center gap-1 px-3 py-0.5 hover:bg-accent/40 transition-colors cursor-pointer"
                    onClick={() => handleOpenDiff(entry)}
                  >
                    <StatusIcon className={cn('size-3.5 shrink-0', STATUS_COLORS[entry.status])} />
                    <span className="truncate text-[12px] flex-1 min-w-0">
                      <span className="text-foreground">{fileName}</span>
                      {dirPath && (
                        <span className="text-muted-foreground ml-1.5 text-[11px]">{dirPath}</span>
                      )}
                    </span>
                    <span
                      className={cn(
                        'text-[10px] font-bold shrink-0 w-4 text-center',
                        STATUS_COLORS[entry.status]
                      )}
                    >
                      {STATUS_LABELS[entry.status]}
                    </span>

                    {/* Action buttons */}
                    <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity shrink-0">
                      {area === 'unstaged' || area === 'untracked' ? (
                        <>
                          {area === 'unstaged' && (
                            <ActionButton
                              icon={Undo2}
                              title="Discard changes"
                              onClick={(e) => {
                                e.stopPropagation()
                                void handleDiscard(entry.path)
                              }}
                            />
                          )}
                          <ActionButton
                            icon={Plus}
                            title="Stage"
                            onClick={(e) => {
                              e.stopPropagation()
                              void handleStage(entry.path)
                            }}
                          />
                        </>
                      ) : (
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
    <button
      className="p-0.5 rounded hover:bg-accent text-muted-foreground hover:text-foreground transition-colors"
      title={title}
      onClick={onClick}
    >
      <Icon className="size-3" />
    </button>
  )
}
