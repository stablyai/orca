import { useCallback, useMemo, useRef, useState } from 'react'
import { BoundedMap } from '../../../../../../shared/bounded-map'
import { resolveSourceControlGroupOrder } from '../listing/section-order'
import { getNextSourceControlViewMode } from './header-toolbar'
import { normalizeSourceControlViewMode } from '../commit/commit-drafts'
import type { SourceControlStoreActions } from '../listing/use-store-actions'
import type { SourceControlWorktreeContext } from '../listing/use-worktree-context'

const DEFAULT_COLLAPSED_SECTIONS = ['history'] as const

function createDefaultCollapsedSections(): Set<string> {
  return new Set(DEFAULT_COLLAPSED_SECTIONS)
}

// Preserve per-worktree disclosure across sidebar-tab unmounts for this renderer session.
const collapsedSectionsByWorktree = new BoundedMap<string, Set<string>>({ maxEntries: 512 })

function readCollapsedSections(worktreeId: string | null): Set<string> {
  return (
    (worktreeId ? collapsedSectionsByWorktree.get(worktreeId) : undefined) ??
    createDefaultCollapsedSections()
  )
}

export function useSourceControlPanelViewState({
  activeWorktreeId,
  settings,
  updateSettings
}: {
  activeWorktreeId: string | null
  settings: SourceControlWorktreeContext['settings']
  updateSettings: SourceControlStoreActions['updateSettings']
}) {
  const sourceControlRef = useRef<HTMLDivElement | null>(null)
  // Use state so virtual lists start observing the shared scroller when its element attaches.
  const [fileListScrollElement, setFileListScrollElement] = useState<HTMLDivElement | null>(null)
  const isMac = useMemo(() => navigator.userAgent.includes('Mac'), [])
  const [filterExpanded, setFilterExpanded] = useState(false)
  const [collapsedSections, setCollapsedSections] = useState<Set<string>>(() =>
    readCollapsedSections(activeWorktreeId)
  )
  const persistedSourceControlViewMode = normalizeSourceControlViewMode(
    settings?.sourceControlViewMode
  )
  const sourceControlViewMode = persistedSourceControlViewMode
  const sourceControlGroupOrder = resolveSourceControlGroupOrder(settings?.sourceControlGroupOrder)
  const [collapsedTreeDirs, setCollapsedTreeDirs] = useState<Set<string>>(new Set())
  const [baseRefDialogOpen, setBaseRefDialogOpen] = useState(false)
  const [filterQuery, setFilterQuery] = useState('')
  const isGitHistoryExpanded = !collapsedSections.has('history')

  const handleToggleSourceControlViewMode = useCallback(() => {
    if (!settings) {
      return
    }
    updateSettings({
      sourceControlViewMode: getNextSourceControlViewMode(sourceControlViewMode)
    })
  }, [settings, sourceControlViewMode, updateSettings])

  // Reset during render; key-based remounts on switches caused Windows IPC storms.
  const [viewStateWorktreeId, setViewStateWorktreeId] = useState(activeWorktreeId)
  if (viewStateWorktreeId !== activeWorktreeId) {
    setViewStateWorktreeId(activeWorktreeId)
    setFilterExpanded(false)
    setCollapsedSections(readCollapsedSections(activeWorktreeId))
    setCollapsedTreeDirs(new Set())
    setBaseRefDialogOpen(false)
    // Preserve repo-scoped defaultBaseRef and per-worktree in-flight commits so switches cannot clobber defaults or enable duplicate commits.
    setFilterQuery('')
    // Why: don't reset commit-in-flight state — it's per-worktree; resetting would re-enable Commit for an incoming worktree mid-commit.
  }

  const toggleSection = useCallback(
    (section: string) => {
      const next = new Set(collapsedSections)
      if (next.has(section)) {
        next.delete(section)
      } else {
        next.add(section)
      }
      setCollapsedSections(next)
      if (activeWorktreeId) {
        collapsedSectionsByWorktree.set(activeWorktreeId, next)
      }
    },
    [activeWorktreeId, collapsedSections]
  )

  const toggleTreeDir = useCallback((key: string) => {
    setCollapsedTreeDirs((prev) => {
      const next = new Set(prev)
      if (next.has(key)) {
        next.delete(key)
      } else {
        next.add(key)
      }
      return next
    })
  }, [])

  return {
    baseRefDialogOpen,
    collapsedSections,
    collapsedTreeDirs,
    fileListScrollElement,
    filterExpanded,
    filterQuery,
    handleToggleSourceControlViewMode,
    isGitHistoryExpanded,
    isMac,
    setBaseRefDialogOpen,
    setFileListScrollElement,
    setFilterExpanded,
    setFilterQuery,
    sourceControlGroupOrder,
    sourceControlRef,
    sourceControlViewMode,
    toggleSection,
    toggleTreeDir
  }
}

export type SourceControlPanelViewState = ReturnType<typeof useSourceControlPanelViewState>
