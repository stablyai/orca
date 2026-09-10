import { useRef, useState } from 'react'
import type { GitStatusResult } from '../../../../shared/git-status-types'
import { useAppStore } from '../../store'
import { getRepoMapFromState, getWorktreeMapFromState } from '../../store/selectors'
import type {
  WorkspaceSpaceSortDirection,
  WorkspaceSpaceSortKey
} from './workspace-space-presentation'
import type { WorkspaceGitRefreshState } from './workspace-space-manager-state-types'

export function useWorkspaceSpaceManagerBindings() {
  const analysis = useAppStore((state) => state.workspaceSpaceAnalysis)
  const progress = useAppStore((state) => state.workspaceSpaceScanProgress)
  const scanError = useAppStore((state) => state.workspaceSpaceScanError)
  const isScanning = useAppStore((state) => state.workspaceSpaceScanning)
  const refreshWorkspaceSpace = useAppStore((state) => state.refreshWorkspaceSpace)
  const cancelWorkspaceSpaceScan = useAppStore((state) => state.cancelWorkspaceSpaceScan)
  const removeWorkspaceSpaceWorktrees = useAppStore((state) => state.removeWorkspaceSpaceWorktrees)
  const removeWorktree = useAppStore((state) => state.removeWorktree)
  const deleteStateByWorktreeId = useAppStore((state) => state.deleteStateByWorktreeId)
  const repoMap = useAppStore((state) => getRepoMapFromState(state))
  const repos = useAppStore((state) => state.repos)
  const worktreeMap = useAppStore((state) => getWorktreeMapFromState(state))
  const tabsByWorktree = useAppStore((state) => state.tabsByWorktree)
  const ptyIdsByTabId = useAppStore((state) => state.ptyIdsByTabId)
  const agentStatusByPaneKey = useAppStore((state) => state.agentStatusByPaneKey)
  const migrationUnsupportedByPtyId = useAppStore((state) => state.migrationUnsupportedByPtyId)
  const runtimePaneTitlesByTabId = useAppStore((state) => state.runtimePaneTitlesByTabId)
  const agentStatusEpoch = useAppStore((state) => state.agentStatusEpoch)
  const retainedAgentsByPaneKey = useAppStore((state) => state.retainedAgentsByPaneKey)
  const openFiles = useAppStore((state) => state.openFiles)
  const editorDrafts = useAppStore((state) => state.editorDrafts)
  const browserTabsByWorktree = useAppStore((state) => state.browserTabsByWorktree)
  const gitStatusByWorktree = useAppStore((state) => state.gitStatusByWorktree)
  const remoteStatusesByWorktree = useAppStore((state) => state.remoteStatusesByWorktree)
  const hostedReviewCache = useAppStore((state) => state.hostedReviewCache)
  const issueCache = useAppStore((state) => state.issueCache)
  const linearIssueCache = useAppStore((state) => state.linearIssueCache)
  const settings = useAppStore((state) => state.settings)
  const activeWorktreeId = useAppStore((state) => state.activeWorktreeId)
  const activeWorkspaceExecutionHostId = useAppStore(
    (state) => state.activeWorkspaceExecutionHostId
  )
  const setGitStatus = useAppStore((state) => state.setGitStatus)
  const updateWorktreeGitIdentity = useAppStore((state) => state.updateWorktreeGitIdentity)
  const setUpstreamStatus = useAppStore((state) => state.setUpstreamStatus)
  const fetchUpstreamStatus = useAppStore((state) => state.fetchUpstreamStatus)
  const [query, setQuery] = useState('')
  const [onlyDeletable, setOnlyDeletable] = useState(false)
  const [sortKey, setSortKey] = useState<WorkspaceSpaceSortKey>('size')
  const [sortDirection, setSortDirection] = useState<WorkspaceSpaceSortDirection>('desc')
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set())
  const [inspectedWorktreeId, setInspectedWorktreeId] = useState<string | null>(null)
  const [treemapZoomWorktreeId, setTreemapZoomWorktreeId] = useState<string | null>(null)
  const [gitRefreshStateByWorktreeId, setGitRefreshStateByWorktreeId] = useState<
    Record<string, WorkspaceGitRefreshState>
  >({})
  const [gitStatusByWorktreeIdentity, setGitStatusByWorktreeIdentity] = useState<
    Map<string, GitStatusResult['entries']>
  >(() => new Map())
  const gitStatusScanGenerationRef = useRef<number | null>(analysis?.scannedAt ?? null)
  const gitStatusByWorktreeIdentityRef = useRef(gitStatusByWorktreeIdentity)
  const inFlightGitStatusRefreshes = useRef<Set<string>>(new Set())

  return {
    analysis,
    progress,
    scanError,
    isScanning,
    refreshWorkspaceSpace,
    cancelWorkspaceSpaceScan,
    removeWorkspaceSpaceWorktrees,
    removeWorktree,
    deleteStateByWorktreeId,
    repoMap,
    repos,
    worktreeMap,
    tabsByWorktree,
    ptyIdsByTabId,
    agentStatusByPaneKey,
    migrationUnsupportedByPtyId,
    runtimePaneTitlesByTabId,
    agentStatusEpoch,
    retainedAgentsByPaneKey,
    openFiles,
    editorDrafts,
    browserTabsByWorktree,
    gitStatusByWorktree,
    remoteStatusesByWorktree,
    hostedReviewCache,
    issueCache,
    linearIssueCache,
    settings,
    activeWorktreeId,
    activeWorkspaceExecutionHostId,
    setGitStatus,
    updateWorktreeGitIdentity,
    setUpstreamStatus,
    fetchUpstreamStatus,
    query,
    setQuery,
    onlyDeletable,
    setOnlyDeletable,
    sortKey,
    setSortKey,
    sortDirection,
    setSortDirection,
    selectedIds,
    setSelectedIds,
    inspectedWorktreeId,
    setInspectedWorktreeId,
    treemapZoomWorktreeId,
    setTreemapZoomWorktreeId,
    gitRefreshStateByWorktreeId,
    setGitRefreshStateByWorktreeId,
    gitStatusByWorktreeIdentity,
    setGitStatusByWorktreeIdentity,
    gitStatusScanGenerationRef,
    gitStatusByWorktreeIdentityRef,
    inFlightGitStatusRefreshes
  }
}
