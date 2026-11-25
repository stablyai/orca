import { useAppStore } from '@/store'
import { useSourceControlSectionActive } from './worktree-scope'
import { useCallback, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { BoundedMap } from '../../../../../../shared/collections/bounded-map'
import { resolveSourceControlGroupOrder } from '../../../../../../shared/source-control/listing/source-control-section-order'
import { getNextSourceControlViewMode } from './header-toolbar'
import { normalizeSourceControlViewMode } from '../commit/commit-drafts'
import type { SourceControlStoreActions } from '../listing/use-store-actions'
import type { SourceControlWorktreeContext } from '../listing/use-worktree-context'
import {
  ALL_CHANGES_SCOPE,
  getChangeScopeSessionRevision,
  subscribeChangeScopeSession,
  readRememberedChangeScope,
  rememberChangeScope,
  type SourceControlChangeScope,
  type SourceControlCommitScopeFiles
} from './change-scope'

function createDefaultCollapsedSections(): Set<string> {
  return new Set()
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
  owner,
  settings,
  updateSettings
}: {
  owner: string
  activeWorktreeId: string | null
  settings: SourceControlWorktreeContext['settings']
  updateSettings: SourceControlStoreActions['updateSettings']
}) {
  const sectionActive = useSourceControlSectionActive()
  const subscribeScopeSession = useCallback(
    (listener: () => void) => (sectionActive ? subscribeChangeScopeSession(listener) : () => {}),
    [sectionActive]
  )
  const scopeSessionRevision = useSyncExternalStore(
    subscribeScopeSession,
    getChangeScopeSessionRevision
  )
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
  // Store-backed so diff-change navigation can follow the panel's active filter.
  const filterQuery = useAppStore((s) => s.sourceControlFilterQuery)
  const setFilterQuery = useAppStore((s) => s.setSourceControlFilterQuery)
  const [changeScope, setChangeScopeState] = useState<SourceControlChangeScope>(() =>
    readRememberedChangeScope(activeWorktreeId, owner)
  )
  const [commitScopeFiles, setCommitScopeFiles] = useState<SourceControlCommitScopeFiles | null>(
    null
  )
  const [changeScopeMenuOpen, setChangeScopeMenuOpen] = useState(false)
  const setChangeScope = useCallback(
    (scope: SourceControlChangeScope) => {
      rememberChangeScope(activeWorktreeId, scope, owner)
      setChangeScopeState(scope)
    },
    [activeWorktreeId, owner]
  )

  const handleToggleSourceControlViewMode = useCallback(() => {
    const current = useAppStore.getState().settings
    if (!current) {
      return
    }
    updateSettings({
      sourceControlViewMode: getNextSourceControlViewMode(
        normalizeSourceControlViewMode(current.sourceControlViewMode)
      )
    })
  }, [updateSettings])

  // Reset during render; key-based remounts on switches caused Windows IPC storms.
  const viewIdentity = JSON.stringify([activeWorktreeId, owner, scopeSessionRevision])
  const [viewStateWorktreeId, setViewStateWorktreeId] = useState(viewIdentity)
  if (viewStateWorktreeId !== viewIdentity) {
    setViewStateWorktreeId(viewIdentity)
    setFilterExpanded(false)
    setCollapsedSections(readCollapsedSections(activeWorktreeId))
    setCollapsedTreeDirs(new Set())
    setBaseRefDialogOpen(false)
    // Preserve repo-scoped defaultBaseRef and per-worktree in-flight commits so switches cannot clobber defaults or enable duplicate commits.
    setFilterQuery('')
    rememberChangeScope(activeWorktreeId, ALL_CHANGES_SCOPE, owner)
    setChangeScopeState(ALL_CHANGES_SCOPE)
    setCommitScopeFiles(null)
    setChangeScopeMenuOpen(false)
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
    changeScope,
    changeScopeMenuOpen,
    collapsedSections,
    commitScopeFiles,
    collapsedTreeDirs,
    fileListScrollElement,
    filterExpanded,
    filterQuery,
    handleToggleSourceControlViewMode,
    isMac,
    setBaseRefDialogOpen,
    setChangeScope,
    setChangeScopeMenuOpen,
    setCommitScopeFiles,
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
