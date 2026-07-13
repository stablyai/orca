/* oxlint-disable max-lines */
import React, { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import {
  FileText,
  FolderTree,
  Globe,
  Plus,
  Server,
  ServerOff,
  Smartphone,
  SquareTerminal
} from 'lucide-react'
import { useAppStore } from '@/store'
import { getRepoMapFromState, useAllWorktrees } from '@/store/selectors'
import { selectPaletteStatusInputs } from './worktree-jump-palette-status-inputs'
import {
  CommandDialog,
  CommandInput,
  CommandList,
  CommandEmpty,
  CommandItem
} from '@/components/ui/command'
import { branchName } from '@/lib/git-utils'
import { parseGitHubIssueOrPRNumber, parseGitHubIssueOrPRLink } from '@/lib/github-links'
import { getLinkedWorkItemSuggestedName, getLinkedWorkItemWorkspaceName } from '@/lib/new-workspace'
import type { LinkedWorkItemSummary } from '@/lib/new-workspace'
import { sortWorktreesSmart } from '@/components/sidebar/smart-sort'
import {
  isAutomationGeneratedWorkspace,
  isDefaultBranchWorkspace
} from '@/components/sidebar/visible-worktrees'
import { getLiveAgentStatusByWorktreeId, isInactiveWorkspace } from '@/lib/worktree-activity-state'
import { orderEmptyQueryWorktrees } from '@/lib/order-empty-query-worktrees'
import StatusIndicator from '@/components/sidebar/StatusIndicator'
import { cn } from '@/lib/utils'
import { getWorktreeStatus, getWorktreeStatusLabel } from '@/lib/worktree-status'
import { activateAndRevealWorktree } from '@/lib/worktree-activation'
import { findWorktreeById } from '@/store/slices/worktree-helpers'
import {
  getWorktreePaletteSearchScope,
  searchWorktrees,
  type MatchRange,
  type PaletteSearchResult
} from '@/lib/worktree-palette-search'
import {
  CREATE_WORKTREE_ITEM_ID,
  createWorktreePaletteRequestGuard,
  getNextWorktreePaletteSelection,
  getWorktreePaletteSelectionItemIds,
  getWorktreePaletteCreateActionState
} from '@/lib/worktree-palette-create-action'
import { getWorkspacePortsByWorktreeId } from '@/lib/workspace-port-groups'
import {
  isBlankBrowserUrl,
  searchBrowserPages,
  type BrowserPaletteSearchResult,
  type SearchableBrowserPage
} from '@/lib/browser-palette-search'
import {
  buildSearchableSimulatorTabs,
  searchSimulatorTabs,
  type SearchableSimulatorTab,
  type SimulatorPaletteSearchResult
} from '@/lib/simulator-palette-search'
import {
  buildSearchableWorkspaceTabs,
  searchWorkspaceTabs,
  type SearchableWorkspaceTab,
  type WorkspaceTabPaletteSearchResult
} from '@/lib/workspace-tab-palette-search'
import { activateWorkspaceTabPaletteResult } from '@/lib/workspace-tab-palette-activation'
import {
  ORCA_BROWSER_FOCUS_REQUEST_EVENT,
  queueBrowserFocusRequest
} from '@/components/browser-pane/browser-focus'
import { RepoBadgeMark } from '@/components/repo/RepoBadgeLabel'
import { buildSidebarHostOptions } from '@/components/sidebar/sidebar-host-options'
import { getPaletteHostBadge, type PaletteHostBadge } from '@/components/cmd-j/palette-host-badge'
import { useSettingsNavigationMetadata } from '@/hooks/useSettingsNavigationMetadata'
import { runWorktreeDelete } from '@/components/sidebar/delete-worktree-flow'
import {
  buildCmdJActionResults,
  buildCmdJSettingsResults,
  rankCmdJMiddleResults,
  type CmdJActionResult,
  type CmdJSettingsResult
} from '@/components/cmd-j/palette-results'
import { buildImportedWorktreesCardCandidates } from '@/components/sidebar/imported-worktrees-card-candidates'
import {
  hasCmdJProjectSearchCandidates,
  searchCmdJProjectResults,
  type CmdJProjectSearchResult
} from '@/components/cmd-j/palette-project-results'
import {
  buildCmdJQuickActionContext,
  captureCmdJActiveGroupSnapshot,
  getUnavailableQuickActionMessage,
  type CmdJActiveGroupSnapshot
} from '@/components/cmd-j/quick-action-context'
import {
  getCmdJQuickActions,
  CREATE_WORKSPACE_QUICK_ACTION_ID
} from '@/components/cmd-j/quick-actions'
import {
  getComposerEligibleRepos,
  resolveComposerGitRepoId
} from '@/lib/new-workspace-composer-repo'
import {
  lookupGitHubWorkItemByOwnerRepoForSource,
  lookupGitHubWorkItemForSource
} from '@/lib/github-work-item-source-lookup'
import type { SettingsNavTarget } from '@/lib/settings-navigation-types'
import { getHostDisplayLabelOverrides } from '../../../shared/host-setting-overrides'
import { isRuntimeOwnedSshTargetId } from '../../../shared/execution-host'
import type { BrowserPage, BrowserWorkspace, Worktree } from '../../../shared/types'
import { isGitRepoKind } from '../../../shared/repo-kind'
import { buildTaskSourceContextFromRepo } from '../../../shared/task-source-context'
import { translate } from '@/i18n/i18n'

type WorktreePaletteItem = {
  id: string
  type: 'worktree'
  match: PaletteSearchResult
  worktree: Worktree
}

type BrowserPaletteItem = {
  id: string
  type: 'browser-page'
  result: BrowserPaletteSearchResult
}

type SimulatorPaletteItem = {
  id: string
  type: 'simulator-tab'
  result: SimulatorPaletteSearchResult
}

type WorkspaceTabPaletteItem = {
  id: string
  type: 'workspace-tab'
  result: WorkspaceTabPaletteSearchResult
}

type SettingsPaletteItem = {
  id: string
  type: 'settings'
  result: CmdJSettingsResult
}

type QuickActionPaletteItem = {
  id: string
  type: 'quick-action'
  result: CmdJActionResult
}

type ProjectTargetPaletteItem = {
  id: string
  type: 'project-target'
  result: CmdJProjectSearchResult
}

type SectionHeader = {
  id: string
  type: 'section-header'
  label: string
}

type HintRow = {
  id: string
  type: 'hint'
  label: string
}

type CreateWorktreePaletteItem = {
  id: typeof CREATE_WORKTREE_ITEM_ID
  type: 'create-worktree'
}

// Why: Cmd+J is a fast intent surface, not a dump of every setup button.
// Keep future quick actions curated; route one-time setup flows through Settings.
type PaletteItem =
  | WorktreePaletteItem
  | ProjectTargetPaletteItem
  | SettingsPaletteItem
  | QuickActionPaletteItem
  | BrowserPaletteItem
  | SimulatorPaletteItem
  | WorkspaceTabPaletteItem

type PaletteListEntry = PaletteItem | CreateWorktreePaletteItem | SectionHeader | HintRow

const CREATE_WORKSPACE_QUICK_ACTION_ITEM_ID = `quick-action:${CREATE_WORKSPACE_QUICK_ACTION_ID}`

// Why: comfortably outlast the CommandDialog close animation (~150–200ms) so the
// gated status maps stay live until the fading rows are gone from the DOM.
const PALETTE_STATUS_INPUTS_LINGER_MS = 300

function getComposerPrefetchRepoId(
  state: ReturnType<typeof useAppStore.getState>,
  initialRepoId?: string
): string | null {
  return resolveComposerGitRepoId({
    eligibleRepos: getComposerEligibleRepos(state.repos),
    initialRepoId,
    activeRepoId: state.activeRepoId,
    focusedHostScope: state.workspaceHostScope
  })
}

function appendPaletteListEntries(
  target: PaletteListEntry[],
  source: readonly PaletteItem[]
): void {
  // Why: query mode can expose generated-size workspace/tab result lists.
  // Avoid the function argument limit from `push(...source)`.
  for (const entry of source) {
    target.push(entry)
  }
}

type BrowserSelection = {
  worktree: Worktree
  workspace: BrowserWorkspace
  page: BrowserPage
}

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

function PaletteHostBadgeChip({
  badge
}: {
  badge: PaletteHostBadge | null
}): React.JSX.Element | null {
  if (!badge) {
    return null
  }
  // Host labels come from the registry and are intentionally not translated.
  return (
    <span
      aria-label={translate(
        'auto.components.WorktreeJumpPalette.paletteHostBadge',
        'Host: {{value0}}',
        { value0: badge.label }
      )}
      className="max-w-[140px] truncate rounded-[6px] border border-border/60 bg-background/45 px-1.5 py-px text-[9px] font-medium leading-normal text-muted-foreground/88"
    >
      {badge.label}
    </span>
  )
}

function findBrowserSelection(
  pageId: string,
  workspaceId: string,
  worktreeId: string
): BrowserSelection | null {
  const state = useAppStore.getState()
  const page = (state.browserPagesByWorkspace[workspaceId] ?? []).find((p) => p.id === pageId)
  if (!page) {
    return null
  }
  const workspace = (state.browserTabsByWorktree[worktreeId] ?? []).find(
    (w) => w.id === workspaceId
  )
  if (!workspace) {
    return null
  }
  const worktree = findWorktreeById(state.worktreesByRepo, worktreeId)
  if (!worktree) {
    return null
  }
  return { page, workspace, worktree }
}

function getSettingsTargetFromSectionId(sectionId: string): {
  pane: SettingsNavTarget
  repoId: string | null
  sectionId?: string
} {
  if (sectionId.startsWith('repo-')) {
    return { pane: 'repo', repoId: sectionId.slice('repo-'.length) }
  }
  return { pane: sectionId as SettingsNavTarget, repoId: null }
}

export default function WorktreeJumpPalette(): React.JSX.Element | null {
  // Why: subscribe this palette to language changes; translated memo contents
  // recompute on the rerender without using i18n.language as a fake dependency.
  useTranslation()
  const visible = useAppStore((s) => s.activeModal === 'worktree-palette')
  const closeModal = useAppStore((s) => s.closeModal)
  const openModal = useAppStore((s) => s.openModal)
  const openSettingsPage = useAppStore((s) => s.openSettingsPage)
  const openSettingsTarget = useAppStore((s) => s.openSettingsTarget)
  const recordFeatureInteraction = useAppStore((s) => s.recordFeatureInteraction)
  const revealSidebarRow = useAppStore((s) => s.revealSidebarRow)
  const worktreesByRepo = useAppStore((s) => s.worktreesByRepo)
  const allWorktrees = useAllWorktrees()
  const repos = useAppStore((s) => s.repos)
  const projectGroups = useAppStore((s) => s.projectGroups)
  const projects = useAppStore((s) => s.projects)
  const projectHostSetups = useAppStore((s) => s.projectHostSetups)
  const detectedWorktreesByRepo = useAppStore((s) => s.detectedWorktreesByRepo)
  const pendingWorktreeCreations = useAppStore((s) => s.pendingWorktreeCreations)
  // Why: keep the (very hot) status maps subscribed through the dialog's close
  // animation. `visible` flips false synchronously on close, but the CommandDialog
  // content stays mounted while it fades/zooms out — dropping the maps to empty
  // there would flash the switcher rows empty/reordered mid-animation. Linger a
  // beat past close, then let the gate drop the subscription.
  const [statusInputsLingering, setStatusInputsLingering] = useState(false)
  useEffect(() => {
    if (visible) {
      setStatusInputsLingering(true)
      return
    }
    const timer = window.setTimeout(
      () => setStatusInputsLingering(false),
      PALETTE_STATUS_INPUTS_LINGER_MS
    )
    return () => window.clearTimeout(timer)
  }, [visible])
  // Why: these five status maps drive per-worktree live/working dots and the
  // switcher sort, but only matter while the palette is active. Two of them
  // (agentStatusByPaneKey, runtimePaneTitlesByTabId) get a new identity on every
  // agent-status / pane-title write app-wide, so subscribing to them while the
  // always-mounted palette is closed re-rendered it on unrelated terminals. Gate
  // the subscription on active-or-still-closing: a shared frozen constant while
  // inactive keeps useShallow referentially equal across the churn, and the live
  // maps flow through the instant the palette opens.
  // - runtimePaneTitlesByTabId: split-pane tabs with a working agent in a
  //   non-focused pane still surface as 'working' (matches the sidebar spinner).
  // - ptyIdsByTabId: the live-pty source of truth — slept tabs keep a wake-hint
  //   sessionId in tab.ptyId, so without it the palette dot would lie green.
  const {
    agentStatusByPaneKey,
    runtimePaneTitlesByTabId,
    ptyIdsByTabId,
    terminalLayoutsByTabId,
    tabsByWorktree
  } = useAppStore(useShallow((s) => selectPaletteStatusInputs(s, visible || statusInputsLingering)))
  const agentStatusEpoch = useAppStore((s) =>
    visible || statusInputsLingering ? s.agentStatusEpoch : 0
  )
  const prCache = useAppStore((s) => s.prCache)
  const issueCache = useAppStore((s) => s.issueCache)
  const migrationUnsupportedByPtyId = useAppStore((s) => s.migrationUnsupportedByPtyId)
  const activeWorktreeId = useAppStore((s) => s.activeWorktreeId)
  const activeTabType = useAppStore((s) => s.activeTabType)
  const activeTabId = useAppStore((s) => s.activeTabId)
  const activeTabIdByWorktree = useAppStore((s) => s.activeTabIdByWorktree)
  const activeFileId = useAppStore((s) => s.activeFileId)
  const activeFileIdByWorktree = useAppStore((s) => s.activeFileIdByWorktree)
  const activeTabTypeByWorktree = useAppStore((s) => s.activeTabTypeByWorktree)
  const activeBrowserTabId = useAppStore((s) => s.activeBrowserTabId)
  const browserTabsByWorktree = useAppStore((s) => s.browserTabsByWorktree)
  const browserPagesByWorkspace = useAppStore((s) => s.browserPagesByWorkspace)
  const unifiedTabsByWorktree = useAppStore((s) => s.unifiedTabsByWorktree)
  const openFiles = useAppStore((s) => s.openFiles)
  const activeGroupIdByWorktree = useAppStore((s) => s.activeGroupIdByWorktree)
  const groupsByWorktree = useAppStore((s) => s.groupsByWorktree)
  const retainedAgentsByPaneKey = useAppStore((s) => s.retainedAgentsByPaneKey)
  const sleepingAgentSessionsByPaneKey = useAppStore((s) => s.sleepingAgentSessionsByPaneKey)
  const settings = useAppStore((s) => s.settings)
  const sshTargetLabels = useAppStore((s) => s.sshTargetLabels)
  const sshConnectionStates = useAppStore((s) => s.sshConnectionStates)
  const runtimeEnvironments = useAppStore((s) => s.runtimeEnvironments)
  const runtimeStatusByEnvironmentId = useAppStore((s) => s.runtimeStatusByEnvironmentId)
  const hideDefaultBranchWorkspace = useAppStore((s) => s.hideDefaultBranchWorkspace)
  const hideAutomationGeneratedWorkspaces = useAppStore((s) => s.hideAutomationGeneratedWorkspaces)
  const showSleepingWorkspaces = useAppStore((s) => s.showSleepingWorkspaces)
  const lastVisitedAtByWorktreeId = useAppStore((s) => s.lastVisitedAtByWorktreeId)
  const workspacePortScan = useAppStore((s) => s.workspacePortScan?.result ?? null)
  const openNewBrowserTabInActiveWorkspace = useAppStore(
    (s) => s.openNewBrowserTabInActiveWorkspace
  )
  const openNewMarkdownInActiveWorkspace = useAppStore((s) => s.openNewMarkdownInActiveWorkspace)
  const openNewTerminalTabInActiveWorkspace = useAppStore(
    (s) => s.openNewTerminalTabInActiveWorkspace
  )
  const settingsSections = useSettingsNavigationMetadata()

  const [query, setQuery] = useState('')
  const deferredQuery = useDeferredValue(query)
  const [selectedItemId, setSelectedItemId] = useState('')
  const previousWorktreeIdRef = useRef<string | null>(null)
  const previousActiveTabTypeRef = useRef<'browser' | 'editor' | 'terminal' | 'simulator'>(
    'terminal'
  )
  const previousBrowserPageIdRef = useRef<string | null>(null)
  const previousBrowserFocusTargetRef = useRef<'webview' | 'address-bar'>('webview')
  const activeGroupSnapshotRef = useRef<CmdJActiveGroupSnapshot | null>(null)
  const wasVisibleRef = useRef(false)
  const skipRestoreFocusRef = useRef(false)
  const listRef = useRef<HTMLDivElement>(null)
  const fallbackFocusOuterFrameRef = useRef<number | null>(null)
  const fallbackFocusInnerFrameRef = useRef<number | null>(null)
  const createLookupGuard = useMemo(() => createWorktreePaletteRequestGuard(), [])
  const preserveCreateLookupOnCloseRef = useRef(false)

  const repoMap = useMemo(() => new Map(repos.map((r) => [r.id, r])), [repos])
  const hostLabelOverrides = useMemo(() => getHostDisplayLabelOverrides(settings), [settings])
  // Why: host badges only appear when more than one execution host exists; reuse
  // the same registry the sidebar host-scope strip builds so labels stay in sync.
  const hostOptions = useMemo(
    () =>
      buildSidebarHostOptions({
        repos,
        sshTargetLabels,
        sshConnectionStates,
        settings,
        runtimeEnvironments,
        runtimeStatusByEnvironmentId,
        hostLabelOverrides
      }),
    [
      repos,
      sshTargetLabels,
      sshConnectionStates,
      settings,
      runtimeEnvironments,
      runtimeStatusByEnvironmentId,
      hostLabelOverrides
    ]
  )
  const canCreateWorktree = repos.length > 0

  const hasQuery = deferredQuery.trim().length > 0
  const isLoading = repos.length > 0 && Object.keys(worktreesByRepo).length === 0

  // Why: keep running-agent workspaces visible under "Hide sleeping" even when
  // their live PTY is momentarily absent, matching the sidebar filter. #7197
  const liveAgentActivity = useMemo(() => {
    void agentStatusEpoch
    const statusByWorktreeId = getLiveAgentStatusByWorktreeId(
      agentStatusByPaneKey,
      tabsByWorktree,
      Date.now()
    )
    return { statusByWorktreeId, worktreeIds: new Set(statusByWorktreeId.keys()) }
  }, [agentStatusByPaneKey, agentStatusEpoch, tabsByWorktree])
  const worktreeIdsWithLiveAgent = liveAgentActivity.worktreeIds

  // Why: the empty-query palette mirrors sidebar filters so opening Search
  // starts from the same quiet list. Typed search switches to the global
  // non-archived scope below.
  const emptyQueryVisibleWorktrees = useMemo(
    () =>
      allWorktrees.filter((worktree) => {
        if (worktree.isArchived) {
          return false
        }
        if (hideDefaultBranchWorkspace && isDefaultBranchWorkspace(worktree)) {
          return false
        }
        if (hideAutomationGeneratedWorkspaces && isAutomationGeneratedWorkspace(worktree)) {
          return false
        }
        if (
          !showSleepingWorkspaces &&
          isInactiveWorkspace(
            worktree.id,
            tabsByWorktree,
            ptyIdsByTabId,
            browserTabsByWorktree,
            worktreeIdsWithLiveAgent
          )
        ) {
          return false
        }
        return true
      }),
    [
      allWorktrees,
      browserTabsByWorktree,
      hideAutomationGeneratedWorkspaces,
      hideDefaultBranchWorkspace,
      ptyIdsByTabId,
      showSleepingWorkspaces,
      tabsByWorktree,
      worktreeIdsWithLiveAgent
    ]
  )

  // Why: empty-query rows use focus-recency (lastVisitedAtByWorktreeId) with
  // lastActivityAt fallback so SSH / quiet worktrees don't get pushed below
  // the fold by noisy local worktrees. Current worktree is excluded from the
  // empty-query rows per product model (Cmd+J is a switch surface, not a
  // "show me everything" surface), but kept in visibleWorktreesForState so
  // empty-state/loading logic remains unaffected.
  // See docs/cmd-j-empty-query-ordering.md.
  const { visibleWorktreesForState, switchableWorktreesForRows } = useMemo(
    () =>
      orderEmptyQueryWorktrees({
        visibleWorktrees: emptyQueryVisibleWorktrees,
        activeWorktreeId,
        lastVisitedAtByWorktreeId
      }),
    [emptyQueryVisibleWorktrees, activeWorktreeId, lastVisitedAtByWorktreeId]
  )

  const searchScopeWorktrees = useMemo(
    () =>
      getWorktreePaletteSearchScope({
        hasQuery,
        allWorktrees,
        emptyQueryWorktrees: switchableWorktreesForRows
      }),
    [allWorktrees, hasQuery, switchableWorktreesForRows]
  )

  // Why: typed queries still route through sortWorktreesSmart — switcher
  // ranking only diverges from smart-sort on the empty-query branch.
  const sortedWorktrees = useMemo(
    () =>
      hasQuery
        ? sortWorktreesSmart(
            searchScopeWorktrees,
            tabsByWorktree,
            repoMap,
            agentStatusByPaneKey,
            runtimePaneTitlesByTabId,
            ptyIdsByTabId,
            migrationUnsupportedByPtyId,
            terminalLayoutsByTabId
          )
        : searchScopeWorktrees,
    [
      hasQuery,
      searchScopeWorktrees,
      tabsByWorktree,
      repoMap,
      agentStatusByPaneKey,
      runtimePaneTitlesByTabId,
      ptyIdsByTabId,
      migrationUnsupportedByPtyId,
      terminalLayoutsByTabId
    ]
  )

  const browserSortedWorktrees = useMemo(() => {
    // Why: browser-tab search is explicitly cross-worktree, so it must keep
    // indexing live browser pages even when their owning worktree is archived
    // or hidden by the default-branch-workspace setting. A user who opened a
    // tab on the default-branch worktree before toggling hide-on should still
    // be able to Cmd+J back to it — the setting hides the *workspace row*,
    // not the browser tabs that live inside it.
    return sortWorktreesSmart(
      allWorktrees,
      tabsByWorktree,
      repoMap,
      agentStatusByPaneKey,
      runtimePaneTitlesByTabId,
      ptyIdsByTabId,
      migrationUnsupportedByPtyId,
      terminalLayoutsByTabId
    )
  }, [
    allWorktrees,
    tabsByWorktree,
    repoMap,
    agentStatusByPaneKey,
    runtimePaneTitlesByTabId,
    ptyIdsByTabId,
    migrationUnsupportedByPtyId,
    terminalLayoutsByTabId
  ])

  // Why: browser rows need worktree lookups for repo badge colors, and browser
  // search intentionally includes archived worktrees. This map must cover all
  // worktrees, not just the non-archived sortedWorktrees used for the Worktrees scope.
  const worktreeMap = useMemo(() => {
    const map = new Map<string, Worktree>()
    for (const worktree of browserSortedWorktrees) {
      map.set(worktree.id, worktree)
    }
    return map
  }, [browserSortedWorktrees])

  const worktreeOrder = useMemo(
    () => new Map(browserSortedWorktrees.map((worktree, index) => [worktree.id, index])),
    [browserSortedWorktrees]
  )

  const worktreeMatches = useMemo(
    () =>
      searchWorktrees(
        sortedWorktrees,
        deferredQuery.trim(),
        repoMap,
        prCache,
        issueCache,
        getWorkspacePortsByWorktreeId(workspacePortScan)
      ),
    [sortedWorktrees, deferredQuery, repoMap, prCache, issueCache, workspacePortScan]
  )

  const browserPageEntries = useMemo<SearchableBrowserPage[]>(() => {
    const entries: SearchableBrowserPage[] = []
    for (const worktree of browserSortedWorktrees) {
      const repoName = repoMap.get(worktree.repoId)?.displayName ?? ''
      const worktreeSortIndex = worktreeOrder.get(worktree.id) ?? Number.MAX_SAFE_INTEGER
      const workspaces = browserTabsByWorktree[worktree.id] ?? []
      for (const workspace of workspaces) {
        const pages = browserPagesByWorkspace[workspace.id] ?? []
        for (const page of pages) {
          entries.push({
            page,
            workspace,
            worktree,
            repoName,
            worktreeSortIndex,
            isCurrentPage:
              activeTabType === 'browser' &&
              workspace.id === activeBrowserTabId &&
              workspace.activePageId === page.id,
            isCurrentWorktree: activeWorktreeId === worktree.id
          })
        }
      }
    }
    return entries
  }, [
    activeBrowserTabId,
    activeTabType,
    activeWorktreeId,
    browserPagesByWorkspace,
    browserTabsByWorktree,
    browserSortedWorktrees,
    repoMap,
    worktreeOrder
  ])

  const browserMatches = useMemo(
    () => searchBrowserPages(browserPageEntries, deferredQuery.trim()),
    [browserPageEntries, deferredQuery]
  )

  const simulatorTabEntries = useMemo<SearchableSimulatorTab[]>(() => {
    return buildSearchableSimulatorTabs({
      worktrees: browserSortedWorktrees,
      repoMap,
      worktreeOrder,
      unifiedTabsByWorktree,
      activeGroupIdByWorktree,
      groupsByWorktree,
      activeWorktreeId,
      activeTabType
    })
  }, [
    activeGroupIdByWorktree,
    activeTabType,
    activeWorktreeId,
    browserSortedWorktrees,
    groupsByWorktree,
    repoMap,
    unifiedTabsByWorktree,
    worktreeOrder
  ])

  const simulatorMatches = useMemo(
    () => searchSimulatorTabs(simulatorTabEntries, deferredQuery.trim()),
    [simulatorTabEntries, deferredQuery]
  )

  const workspaceTabEntries = useMemo<SearchableWorkspaceTab[]>(() => {
    return buildSearchableWorkspaceTabs({
      worktrees: browserSortedWorktrees,
      repoMap,
      worktreeOrder,
      unifiedTabsByWorktree,
      tabsByWorktree,
      openFiles,
      agentStatusByPaneKey,
      retainedAgentsByPaneKey,
      sleepingAgentSessionsByPaneKey,
      activeGroupIdByWorktree,
      groupsByWorktree,
      activeWorktreeId,
      activeTabType,
      activeTabId,
      activeTabIdByWorktree,
      activeFileId,
      activeFileIdByWorktree,
      activeTabTypeByWorktree,
      generatedTitlesEnabled: settings?.tabAutoGenerateTitle === true
    })
  }, [
    activeFileId,
    activeFileIdByWorktree,
    activeGroupIdByWorktree,
    activeTabId,
    activeTabIdByWorktree,
    activeTabType,
    activeTabTypeByWorktree,
    activeWorktreeId,
    agentStatusByPaneKey,
    browserSortedWorktrees,
    groupsByWorktree,
    openFiles,
    repoMap,
    retainedAgentsByPaneKey,
    settings?.tabAutoGenerateTitle,
    sleepingAgentSessionsByPaneKey,
    tabsByWorktree,
    unifiedTabsByWorktree,
    worktreeOrder
  ])

  const workspaceTabMatches = useMemo(
    () => searchWorkspaceTabs(workspaceTabEntries, deferredQuery.trim()),
    [workspaceTabEntries, deferredQuery]
  )

  const worktreeItems = useMemo<WorktreePaletteItem[]>(
    () =>
      worktreeMatches
        .map((match) => {
          const worktree = worktreeMap.get(match.worktreeId)
          if (!worktree) {
            return null
          }
          return {
            id: `worktree:${worktree.id}`,
            type: 'worktree' as const,
            match,
            worktree
          }
        })
        .filter((item): item is WorktreePaletteItem => item !== null),
    [worktreeMap, worktreeMatches]
  )

  const browserItems = useMemo<BrowserPaletteItem[]>(
    () =>
      browserMatches.map((result) => ({
        id: `browser-page:${result.pageId}`,
        type: 'browser-page' as const,
        result
      })),
    [browserMatches]
  )

  const simulatorItems = useMemo<SimulatorPaletteItem[]>(
    () =>
      simulatorMatches.map((result) => ({
        id: `simulator-tab:${result.tabId}`,
        type: 'simulator-tab' as const,
        result
      })),
    [simulatorMatches]
  )

  const workspaceTabItems = useMemo<WorkspaceTabPaletteItem[]>(
    () =>
      workspaceTabMatches.map((result) => ({
        id: `workspace-tab:${result.tabId}`,
        type: 'workspace-tab' as const,
        result
      })),
    [workspaceTabMatches]
  )

  const openTabItems = useMemo<
    (BrowserPaletteItem | SimulatorPaletteItem | WorkspaceTabPaletteItem)[]
  >(
    () =>
      // Why: these result builders emit comparable ascending scores, so one sort
      // keeps cross-source ranking consistent within the OPEN TABS section.
      [...browserItems, ...simulatorItems, ...workspaceTabItems].sort((a, b) => {
        if (a.result.score !== b.result.score) {
          return a.result.score - b.result.score
        }
        return a.id.localeCompare(b.id)
      }),
    [browserItems, simulatorItems, workspaceTabItems]
  )

  const settingsResults = useMemo(
    () => buildCmdJSettingsResults(settingsSections),
    [settingsSections]
  )
  const actionResults = useMemo(() => buildCmdJActionResults(getCmdJQuickActions()), [])
  // Why: Cmd+J should only offer project jumps the sidebar can actually reveal;
  // archived-only repos are intentionally left out of this navigation surface.
  const renderableProjectRepoIds = useMemo(() => {
    const ids = new Set<string>()
    for (const worktree of allWorktrees) {
      if (!worktree.isArchived) {
        ids.add(worktree.repoId)
      }
    }
    for (const repo of repos) {
      if ((worktreesByRepo[repo.id]?.length ?? 0) === 0) {
        ids.add(repo.id)
      }
    }
    for (const repoId of buildImportedWorktreesCardCandidates({
      repos,
      detectedWorktreesByRepo
    }).keys()) {
      ids.add(repoId)
    }
    for (const creation of Object.values(pendingWorktreeCreations)) {
      ids.add(creation.request.repoId)
    }
    return ids
  }, [allWorktrees, detectedWorktreesByRepo, pendingWorktreeCreations, repos, worktreesByRepo])
  const hasAnyProjectSearchCandidates = useMemo(
    () =>
      hasCmdJProjectSearchCandidates({
        projectGroups,
        repos,
        projects,
        projectHostSetups,
        renderableRepoIds: renderableProjectRepoIds
      }),
    [projectGroups, projectHostSetups, projects, renderableProjectRepoIds, repos]
  )
  const projectTargetItems = useMemo<ProjectTargetPaletteItem[]>(
    () =>
      hasQuery
        ? searchCmdJProjectResults({
            query: deferredQuery,
            projectGroups,
            repos,
            projects,
            projectHostSetups,
            renderableRepoIds: renderableProjectRepoIds
          }).map((result) => ({
            id: result.id,
            type: 'project-target' as const,
            result
          }))
        : [],
    [
      deferredQuery,
      hasQuery,
      projectGroups,
      projectHostSetups,
      projects,
      renderableProjectRepoIds,
      repos
    ]
  )

  const prefetchCreateWorkspaceBaseForComposer = useCallback((initialRepoId?: string): void => {
    const state = useAppStore.getState()
    const repoIdForComposer = getComposerPrefetchRepoId(state, initialRepoId)
    if (!repoIdForComposer) {
      return
    }
    void state.prefetchWorktreeCreateBase(repoIdForComposer)
  }, [])

  const openCreateWorkspaceAction = useCallback(() => {
    prefetchCreateWorkspaceBaseForComposer()
    queueMicrotask(() =>
      openModal('new-workspace-composer', { telemetrySource: 'command_palette' })
    )
  }, [openModal, prefetchCreateWorkspaceBaseForComposer])

  const deleteActiveWorkspaceAction = useCallback(() => {
    const { activeView, activeWorktreeId } = useAppStore.getState()
    if (activeView !== 'terminal' || !activeWorktreeId) {
      return
    }
    // Why: the delete confirmation is also a modal; let the palette close
    // before mounting it so Radix focus teardown cannot fight the new dialog.
    queueMicrotask(() => runWorktreeDelete(activeWorktreeId))
  }, [])

  const openAddQuickCommandAction = useCallback(() => {
    openSettingsTarget({ pane: 'quick-commands', repoId: null, intent: 'add-quick-command' })
    openSettingsPage()
  }, [openSettingsPage, openSettingsTarget])

  const buildQuickActionContext = useCallback(
    () =>
      buildCmdJQuickActionContext({
        state: useAppStore.getState(),
        activeGroupSnapshot: activeGroupSnapshotRef.current,
        openNewBrowserTab: openNewBrowserTabInActiveWorkspace,
        openNewMarkdownFile: openNewMarkdownInActiveWorkspace,
        openNewTerminalTab: openNewTerminalTabInActiveWorkspace,
        openCreateWorkspace: openCreateWorkspaceAction,
        deleteActiveWorkspace: deleteActiveWorkspaceAction,
        openAddQuickCommand: openAddQuickCommandAction
      }),
    [
      deleteActiveWorkspaceAction,
      openAddQuickCommandAction,
      openCreateWorkspaceAction,
      openNewBrowserTabInActiveWorkspace,
      openNewMarkdownInActiveWorkspace,
      openNewTerminalTabInActiveWorkspace
    ]
  )

  const quickActionContext = buildQuickActionContext()

  const middleItems = useMemo<(SettingsPaletteItem | QuickActionPaletteItem)[]>(
    () =>
      rankCmdJMiddleResults({
        query: deferredQuery,
        settingsResults,
        actionResults: actionResults.filter(
          (action) => action.isAvailable(quickActionContext).available
        )
      }).map((result) =>
        result.kind === 'settings'
          ? { id: result.id, type: 'settings' as const, result }
          : { id: `quick-action:${result.id}`, type: 'quick-action' as const, result }
      ),
    [actionResults, deferredQuery, quickActionContext, settingsResults]
  )

  // Why: on empty query we cap the worktree section (not open tabs) so the
  // OPEN TABS header + ≥1 tab row stays visible above the fold — users
  // with 30+ worktrees would otherwise never see open tabs. The cap is
  // paired with a "Type to see all N worktrees" hint row so the full list is
  // one keystroke away. Typing lifts both caps. Cap size is tied to the
  // palette's max-h-[min(460px,62vh)] viewport math: ~60px/row, ~32px/header,
  // leaves room for OPEN TABS header + one tab row at default window size.
  // Revisit if row heights or max-h change.
  const EMPTY_QUERY_WORKTREE_CAP = 5
  const EMPTY_QUERY_OPEN_TAB_CAP = 5

  const paletteSections = useMemo(() => {
    // Why: the worktree cap only earns its keep when there are open tabs to
    // protect above-the-fold. With zero open tabs, capping would force
    // the user to type for no reason — uncap so the recent list fills the
    // viewport naturally.
    const worktreeCap = !hasQuery && openTabItems.length > 0 ? EMPTY_QUERY_WORKTREE_CAP : Infinity
    const visibleWorktreeItems = hasQuery ? worktreeItems : worktreeItems.slice(0, worktreeCap)
    const visibleProjectTargetItems = hasQuery ? projectTargetItems : []
    const visibleMiddleItems = hasQuery ? middleItems : []
    const visibleOpenTabItems = hasQuery
      ? openTabItems
      : openTabItems.slice(0, EMPTY_QUERY_OPEN_TAB_CAP)
    const showWorktreeHint = !hasQuery && worktreeItems.length > worktreeCap

    return {
      visibleWorktreeItems,
      visibleProjectTargetItems,
      visibleMiddleItems,
      visibleOpenTabItems,
      showWorktreeHint
    }
  }, [worktreeItems, projectTargetItems, middleItems, openTabItems, hasQuery])

  const selectableItems = useMemo<PaletteItem[]>(
    () => [
      ...paletteSections.visibleWorktreeItems,
      ...paletteSections.visibleProjectTargetItems,
      ...paletteSections.visibleMiddleItems,
      ...paletteSections.visibleOpenTabItems
    ],
    [paletteSections]
  )

  const { createWorktreeName, showCreateAction } = useMemo(
    () =>
      getWorktreePaletteCreateActionState({
        canCreateWorktree,
        query: deferredQuery
      }),
    [canCreateWorktree, deferredQuery]
  )

  const listEntries = useMemo<PaletteListEntry[]>(() => {
    const entries: PaletteListEntry[] = []
    const {
      visibleWorktreeItems,
      visibleProjectTargetItems,
      visibleMiddleItems,
      visibleOpenTabItems,
      showWorktreeHint
    } = paletteSections
    const visibleWorkspaceItemCount = visibleWorktreeItems.length + (showCreateAction ? 1 : 0)
    const populatedSectionCount = [
      visibleWorkspaceItemCount,
      visibleProjectTargetItems.length,
      visibleMiddleItems.length,
      visibleOpenTabItems.length
    ].filter((count) => count > 0).length

    // Header rule: on empty query each section is categorically distinct
    // (worktrees vs. open tabs), so a lone header is a useful signpost. On query,
    // suppress headers unless both sections are populated — otherwise a lone
    // header above one list is noise.
    const showWorktreeHeader = hasQuery
      ? visibleWorkspaceItemCount > 0 && populatedSectionCount > 1
      : visibleWorktreeItems.length > 0
    const showOpenTabsHeader = hasQuery
      ? visibleOpenTabItems.length > 0 && populatedSectionCount > 1
      : visibleOpenTabItems.length > 0
    const showProjectTargetHeader =
      hasQuery && visibleProjectTargetItems.length > 0 && populatedSectionCount > 1
    const showMiddleHeader = hasQuery && visibleMiddleItems.length > 0 && populatedSectionCount > 1

    if (visibleWorkspaceItemCount > 0) {
      if (showWorktreeHeader) {
        entries.push({
          id: '__header_worktrees__',
          type: 'section-header',
          label: hasQuery
            ? translate('auto.components.WorktreeJumpPalette.worktreesHeader', 'Worktrees')
            : translate(
                'auto.components.WorktreeJumpPalette.recentWorktreesHeader',
                'Recent Worktrees'
              )
        })
      }
      appendPaletteListEntries(entries, visibleWorktreeItems)
      if (showWorktreeHint) {
        entries.push({
          id: '__hint_worktree_cap__',
          type: 'hint',
          label: translate(
            'auto.components.WorktreeJumpPalette.dabd819ca1',
            'Type to see all {{value0}} worktrees',
            { value0: worktreeItems.length }
          )
        })
      }
    }
    if (visibleProjectTargetItems.length > 0) {
      if (showProjectTargetHeader) {
        entries.push({
          id: '__header_projects_groups__',
          type: 'section-header',
          label: translate(
            'auto.components.WorktreeJumpPalette.projectsGroupsHeader',
            'Projects & Groups'
          )
        })
      }
      appendPaletteListEntries(entries, visibleProjectTargetItems)
    }
    if (showCreateAction) {
      // Why: project/group jump targets are navigation results; keep them
      // directly after worktree matches before the creation fallback.
      entries.push({ id: CREATE_WORKTREE_ITEM_ID, type: 'create-worktree' })
    }
    if (visibleMiddleItems.length > 0) {
      if (showMiddleHeader) {
        entries.push({
          id: '__header_actions_settings__',
          type: 'section-header',
          label: translate('auto.components.WorktreeJumpPalette.088d66d980', 'Actions & Settings')
        })
      }
      appendPaletteListEntries(entries, visibleMiddleItems)
    }
    if (visibleOpenTabItems.length > 0) {
      if (showOpenTabsHeader) {
        entries.push({
          id: '__header_open_tabs__',
          type: 'section-header',
          label: translate('auto.components.WorktreeJumpPalette.50a1d11d5b', 'Open Tabs')
        })
      }
      appendPaletteListEntries(entries, visibleOpenTabItems)
    }
    return entries
  }, [hasQuery, paletteSections, showCreateAction, worktreeItems.length])

  const selectionItemIds = useMemo(
    () => getWorktreePaletteSelectionItemIds(listEntries),
    [listEntries]
  )

  // Why: empty-state / "has any worktrees?" uses the full visible list
  // (including current) so the palette never claims to be empty just
  // because the only visible worktree is the currently active one.
  // See docs/cmd-j-empty-query-ordering.md.
  const hasAnyWorktrees = visibleWorktreesForState.length > 0
  const hasAnySearchableWorktrees = hasQuery ? searchScopeWorktrees.length > 0 : hasAnyWorktrees
  const hasAnyOpenTabs =
    browserPageEntries.length > 0 ||
    simulatorTabEntries.length > 0 ||
    workspaceTabEntries.length > 0
  const hasAnyMiddleResults = middleItems.length > 0

  useEffect(() => {
    if (visible && !wasVisibleRef.current) {
      recordFeatureInteraction('cmd-j')
      createLookupGuard.invalidate()
      activeGroupSnapshotRef.current = captureCmdJActiveGroupSnapshot(
        useAppStore.getState(),
        activeWorktreeId
      )
      previousWorktreeIdRef.current = activeWorktreeId
      previousActiveTabTypeRef.current = activeTabType
      previousBrowserPageIdRef.current =
        activeWorktreeId && activeTabType === 'browser'
          ? ((browserTabsByWorktree[activeWorktreeId] ?? []).find(
              (workspace) => workspace.id === activeBrowserTabId
            )?.activePageId ?? null)
          : null
      // Why: capture which browser surface had focus *before* Radix Dialog
      // steals it. By onOpenAutoFocus time, document.activeElement has already
      // moved to the dialog content, so address-bar detection must happen here.
      previousBrowserFocusTargetRef.current =
        activeTabType === 'browser' &&
        document.activeElement instanceof HTMLElement &&
        document.activeElement.closest('[data-orca-browser-address-bar="true"]')
          ? 'address-bar'
          : 'webview'
      skipRestoreFocusRef.current = false
      setQuery('')
      setSelectedItemId('')
      listRef.current?.scrollTo(0, 0)
    }

    if (!visible && wasVisibleRef.current) {
      if (preserveCreateLookupOnCloseRef.current) {
        // Why: create intentionally closes the palette before GH resolves;
        // reopening still invalidates the pending lookup above.
        preserveCreateLookupOnCloseRef.current = false
      } else {
        createLookupGuard.invalidate()
      }
      activeGroupSnapshotRef.current = null
    }

    wasVisibleRef.current = visible
  }, [
    activeBrowserTabId,
    activeTabType,
    activeWorktreeId,
    browserTabsByWorktree,
    createLookupGuard,
    recordFeatureInteraction,
    visible
  ])

  const commandSelectedItemId = getNextWorktreePaletteSelection({
    currentSelectedItemId: selectedItemId,
    queryChanged: false,
    selectableItemIds: selectionItemIds,
    showCreateAction
  })

  useEffect(() => {
    const isCreateWorkspaceHighlighted =
      commandSelectedItemId === CREATE_WORKTREE_ITEM_ID ||
      commandSelectedItemId === CREATE_WORKSPACE_QUICK_ACTION_ITEM_ID
    if (!visible || !isCreateWorkspaceHighlighted) {
      return
    }
    // Why: Cmd+J opens the composer after selection; warming the same default
    // repo here buys time while the user is still on the highlighted row.
    prefetchCreateWorkspaceBaseForComposer()
  }, [commandSelectedItemId, prefetchCreateWorkspaceBaseForComposer, visible])

  const handleQueryChange = useCallback((nextQuery: string) => {
    setQuery(nextQuery)
    setSelectedItemId('')
    listRef.current?.scrollTo(0, 0)
  }, [])

  const cancelFallbackFocusFrames = useCallback((): void => {
    if (fallbackFocusOuterFrameRef.current !== null) {
      cancelAnimationFrame(fallbackFocusOuterFrameRef.current)
      fallbackFocusOuterFrameRef.current = null
    }
    if (fallbackFocusInnerFrameRef.current !== null) {
      cancelAnimationFrame(fallbackFocusInnerFrameRef.current)
      fallbackFocusInnerFrameRef.current = null
    }
  }, [])

  useEffect(() => cancelFallbackFocusFrames, [cancelFallbackFocusFrames])

  const focusFallbackSurface = useCallback(() => {
    cancelFallbackFocusFrames()
    fallbackFocusOuterFrameRef.current = requestAnimationFrame(() => {
      fallbackFocusOuterFrameRef.current = null
      fallbackFocusInnerFrameRef.current = requestAnimationFrame(() => {
        fallbackFocusInnerFrameRef.current = null
        const xterm = document.querySelector('.xterm-helper-textarea') as HTMLElement | null
        if (xterm) {
          xterm.focus()
          return
        }
        const monaco = document.querySelector('.monaco-editor textarea') as HTMLElement | null
        if (monaco) {
          monaco.focus()
        }
      })
    })
  }, [cancelFallbackFocusFrames])

  const requestBrowserFocus = useCallback(
    (detail: { pageId: string; target: 'webview' | 'address-bar' }) => {
      queueBrowserFocusRequest(detail)
      window.dispatchEvent(
        new CustomEvent(ORCA_BROWSER_FOCUS_REQUEST_EVENT, {
          detail
        })
      )
    },
    []
  )

  const handleOpenChange = useCallback(
    (open: boolean) => {
      if (open) {
        return
      }

      closeModal()
      if (skipRestoreFocusRef.current) {
        return
      }
      if (previousActiveTabTypeRef.current === 'browser' && previousBrowserPageIdRef.current) {
        // Why: dismissing Cmd+J from a browser surface should return focus to
        // that page, not fall through to the generic terminal/editor fallback.
        requestBrowserFocus({
          pageId: previousBrowserPageIdRef.current,
          target: previousBrowserFocusTargetRef.current
        })
        return
      }
      if (previousWorktreeIdRef.current) {
        focusFallbackSurface()
      }
    },
    [closeModal, focusFallbackSurface, requestBrowserFocus]
  )

  const handleSelectWorktree = useCallback(
    (worktreeId: string) => {
      const worktree = findWorktreeById(useAppStore.getState().worktreesByRepo, worktreeId)
      if (!worktree) {
        toast.error(
          translate('auto.components.WorktreeJumpPalette.2c38630a01', 'Workspace no longer exists')
        )
        return
      }
      activateAndRevealWorktree(worktreeId)
      recordFeatureInteraction('cmd-j-workspace-open')
      skipRestoreFocusRef.current = true
      closeModal()
      setSelectedItemId('')
      focusFallbackSurface()
    },
    [closeModal, focusFallbackSurface, recordFeatureInteraction]
  )

  const handleSelectBrowserPage = useCallback(
    (result: BrowserPaletteSearchResult) => {
      const { pageId, workspaceId, worktreeId } = result
      const selection = findBrowserSelection(pageId, workspaceId, worktreeId)
      if (!selection) {
        toast.error(
          translate(
            'auto.components.WorktreeJumpPalette.d7d496a451',
            'Browser page no longer exists'
          )
        )
        return
      }
      // Why: capture the workspace and page info before activateAndRevealWorktree
      // mutates store state. Store cascades during worktree activation can remap
      // browser workspace state, making a second findBrowserSelection unreliable.
      const { worktree, workspace, page } = selection
      const activated = activateAndRevealWorktree(worktree.id)
      if (!activated) {
        toast.error(
          translate('auto.components.WorktreeJumpPalette.2c38630a01', 'Workspace no longer exists')
        )
        return
      }

      const state = useAppStore.getState()
      state.setActiveBrowserTab(workspace.id)
      state.setActiveBrowserPage(workspace.id, pageId)
      recordFeatureInteraction('cmd-j-browser-page-open')
      skipRestoreFocusRef.current = true
      closeModal()
      setSelectedItemId('')
      requestBrowserFocus({
        pageId,
        target: isBlankBrowserUrl(page.url) ? 'address-bar' : 'webview'
      })
    },
    [closeModal, recordFeatureInteraction, requestBrowserFocus]
  )

  const handleSelectSimulatorTab = useCallback(
    (result: SimulatorPaletteSearchResult) => {
      const state = useAppStore.getState()
      const tab = (state.unifiedTabsByWorktree[result.worktreeId] ?? []).find(
        (candidate) => candidate.id === result.tabId && candidate.contentType === 'simulator'
      )
      if (!tab) {
        toast.error(
          translate(
            'auto.components.WorktreeJumpPalette.7726ce9970',
            'Mobile emulator tab no longer exists'
          )
        )
        return
      }
      const activated = activateAndRevealWorktree(result.worktreeId)
      if (!activated) {
        toast.error(
          translate('auto.components.WorktreeJumpPalette.2c38630a01', 'Workspace no longer exists')
        )
        return
      }

      const nextState = useAppStore.getState()
      nextState.focusGroup(result.worktreeId, tab.groupId)
      nextState.activateTab(tab.id)
      nextState.setActiveTab(tab.id)
      nextState.setActiveTabType('simulator')
      skipRestoreFocusRef.current = true
      closeModal()
      setSelectedItemId('')
    },
    [closeModal]
  )

  const handleSelectWorkspaceTab = useCallback(
    (result: WorkspaceTabPaletteSearchResult) => {
      const activation = activateWorkspaceTabPaletteResult(result)
      if (activation.status === 'failed') {
        toast.error(
          activation.reason === 'missing-worktree'
            ? translate(
                'auto.components.WorktreeJumpPalette.2c38630a01',
                'Workspace no longer exists'
              )
            : translate(
                'auto.components.WorktreeJumpPalette.workspaceTabMissing',
                'Tab no longer exists'
              )
        )
        return
      }

      skipRestoreFocusRef.current = true
      closeModal()
      setSelectedItemId('')
    },
    [closeModal]
  )

  const handleSelectSettings = useCallback(
    (result: CmdJSettingsResult) => {
      const target = getSettingsTargetFromSectionId(result.sectionId)
      if (result.targetSectionId) {
        target.sectionId = result.targetSectionId
      }
      skipRestoreFocusRef.current = true
      closeModal()
      setSelectedItemId('')
      openSettingsTarget(target)
      openSettingsPage()
      recordFeatureInteraction('cmd-j-settings-open')
    },
    [closeModal, openSettingsPage, openSettingsTarget, recordFeatureInteraction]
  )

  const handleSelectQuickAction = useCallback(
    (action: CmdJActionResult) => {
      skipRestoreFocusRef.current = true
      closeModal()
      setSelectedItemId('')
      const ctx = buildQuickActionContext()
      void action.run(ctx).then((result) => {
        if (result.status === 'unavailable') {
          toast.error(getUnavailableQuickActionMessage(action.title, result.reason))
          return
        }
        if (action.id === 'create-workspace') {
          recordFeatureInteraction('cmd-j-create-workspace')
          return
        }
        recordFeatureInteraction('cmd-j-quick-action')
      })
    },
    [buildQuickActionContext, closeModal, recordFeatureInteraction]
  )

  const handleSelectProjectTarget = useCallback(
    (result: CmdJProjectSearchResult) => {
      skipRestoreFocusRef.current = true
      // Why: selecting a project or repo group is a sidebar navigation action;
      // it should reveal the grouping row without activating an arbitrary workspace.
      revealSidebarRow(result.rowKey, { behavior: 'smooth', highlight: true })
      recordFeatureInteraction('cmd-j')
      closeModal()
      setSelectedItemId('')
      if (previousActiveTabTypeRef.current === 'browser' && previousBrowserPageIdRef.current) {
        requestBrowserFocus({
          pageId: previousBrowserPageIdRef.current,
          target: previousBrowserFocusTargetRef.current
        })
        return
      }
      if (previousWorktreeIdRef.current) {
        focusFallbackSurface()
      }
    },
    [
      closeModal,
      focusFallbackSurface,
      recordFeatureInteraction,
      requestBrowserFocus,
      revealSidebarRow
    ]
  )

  const handleSelectItem = useCallback(
    (item: PaletteItem) => {
      if (item.type === 'worktree') {
        handleSelectWorktree(item.worktree.id)
      } else if (item.type === 'project-target') {
        handleSelectProjectTarget(item.result)
      } else if (item.type === 'browser-page') {
        handleSelectBrowserPage(item.result)
      } else if (item.type === 'simulator-tab') {
        handleSelectSimulatorTab(item.result)
      } else if (item.type === 'workspace-tab') {
        handleSelectWorkspaceTab(item.result)
      } else if (item.type === 'settings') {
        handleSelectSettings(item.result)
      } else {
        handleSelectQuickAction(item.result)
      }
    },
    [
      handleSelectBrowserPage,
      handleSelectProjectTarget,
      handleSelectQuickAction,
      handleSelectSettings,
      handleSelectSimulatorTab,
      handleSelectWorkspaceTab,
      handleSelectWorktree
    ]
  )

  const handleCreateWorktree = useCallback(() => {
    skipRestoreFocusRef.current = true
    const trimmed = createWorktreeName.trim()
    const ghLink = parseGitHubIssueOrPRLink(trimmed)
    const ghNumber = parseGitHubIssueOrPRNumber(trimmed)

    const openComposer = (data: Record<string, unknown>): void => {
      prefetchCreateWorkspaceBaseForComposer(
        typeof data.initialRepoId === 'string' ? data.initialRepoId : undefined
      )
      closeModal()
      recordFeatureInteraction('cmd-j-create-workspace')
      // Why: defer opening so Radix fully unmounts the palette's dialog before
      // the composer modal mounts, avoiding focus churn between the two.
      queueMicrotask(() =>
        openModal('new-workspace-composer', { ...data, telemetrySource: 'command_palette' })
      )
    }

    // Case 1: user pasted a GH issue/PR URL.
    if (ghLink) {
      const { slug, number } = ghLink
      const state = useAppStore.getState()

      // Why: the existing-worktree check only needs the issue/PR number, which
      // is repo-agnostic on the worktree meta side. We don't currently cache a
      // repo-slug map, so slug-matching against a specific repo happens
      // implicitly when we pick a repo for the `gh workItem` lookup below.
      const matches = allWorktrees.filter(
        (w) => !w.isArchived && (w.linkedIssue === number || w.linkedPR === number)
      )
      const activeMatch = matches.find((w) => w.repoId === state.activeRepoId) ?? matches[0]
      if (activeMatch) {
        closeModal()
        activateAndRevealWorktree(activeMatch.id)
        recordFeatureInteraction('cmd-j-workspace-open')
        return
      }

      // Resolve via gh.workItem: prefer the active repo, else the first eligible.
      const eligibleRepos = state.repos.filter((r) => isGitRepoKind(r))
      const repoForLookup =
        (state.activeRepoId && eligibleRepos.find((r) => r.id === state.activeRepoId)) ||
        eligibleRepos[0]
      if (!repoForLookup) {
        openComposer({ prefilledName: trimmed })
        return
      }

      prefetchCreateWorkspaceBaseForComposer(repoForLookup.id)
      const sourceContext = buildTaskSourceContextFromRepo({
        provider: 'github',
        projectId: repoForLookup.id,
        repo: repoForLookup
      })
      // Why: awaiting inside the user gesture would leave the palette open
      // indefinitely on slow networks. Close immediately and populate the
      // composer once the lookup returns.
      const lookupToken = createLookupGuard.start()
      preserveCreateLookupOnCloseRef.current = true
      recordFeatureInteraction('cmd-j-create-workspace')
      closeModal()
      void lookupGitHubWorkItemByOwnerRepoForSource({
        repoPath: repoForLookup.path,
        repoId: repoForLookup.id,
        sourceContext,
        owner: slug.owner,
        repo: slug.repo,
        number,
        type: ghLink.type
      })
        .then((item) => {
          if (!createLookupGuard.isCurrent(lookupToken)) {
            return
          }
          const data: Record<string, unknown> = { initialRepoId: repoForLookup.id }
          if (item) {
            const linkedWorkItem: LinkedWorkItemSummary = {
              type: item.type,
              number: item.number,
              title: item.title,
              url: item.url
            }
            data.linkedWorkItem = linkedWorkItem
            data.prefilledName =
              getLinkedWorkItemWorkspaceName(linkedWorkItem)?.seedName ??
              getLinkedWorkItemSuggestedName({ title: item.title })
          } else {
            // Fallback: we couldn't resolve the URL, just seed the name.
            data.prefilledName = `${slug.owner}-${slug.repo}-${number}`
          }
          queueMicrotask(() =>
            openModal('new-workspace-composer', { ...data, telemetrySource: 'command_palette' })
          )
        })
        .catch(() => {
          if (!createLookupGuard.isCurrent(lookupToken)) {
            return
          }
          queueMicrotask(() =>
            openModal('new-workspace-composer', {
              initialRepoId: repoForLookup.id,
              telemetrySource: 'command_palette'
            })
          )
        })
      return
    }

    // Case 2: user typed a raw issue number. Resolve against the active repo.
    if (ghNumber !== null) {
      const state = useAppStore.getState()
      const matches = allWorktrees.filter(
        (w) => !w.isArchived && (w.linkedIssue === ghNumber || w.linkedPR === ghNumber)
      )
      const activeMatch = matches.find((w) => w.repoId === state.activeRepoId) ?? matches[0]
      if (activeMatch) {
        closeModal()
        activateAndRevealWorktree(activeMatch.id)
        recordFeatureInteraction('cmd-j-workspace-open')
        return
      }

      const repoForLookup =
        (state.activeRepoId ? (repoMap.get(state.activeRepoId) ?? null) : null) ||
        [...getRepoMapFromState(state).values()].find((repo) => isGitRepoKind(repo))
      if (!repoForLookup || !isGitRepoKind(repoForLookup)) {
        openComposer({ prefilledName: trimmed })
        return
      }

      prefetchCreateWorkspaceBaseForComposer(repoForLookup.id)
      const sourceContext = buildTaskSourceContextFromRepo({
        provider: 'github',
        projectId: repoForLookup.id,
        repo: repoForLookup
      })
      const lookupToken = createLookupGuard.start()
      preserveCreateLookupOnCloseRef.current = true
      recordFeatureInteraction('cmd-j-create-workspace')
      closeModal()
      void lookupGitHubWorkItemForSource({
        repoPath: repoForLookup.path,
        repoId: repoForLookup.id,
        sourceContext,
        number: ghNumber
      })
        .then((item) => {
          if (!createLookupGuard.isCurrent(lookupToken)) {
            return
          }
          const data: Record<string, unknown> = { initialRepoId: repoForLookup.id }
          if (item) {
            const linkedWorkItem: LinkedWorkItemSummary = {
              type: item.type,
              number: item.number,
              title: item.title,
              url: item.url
            }
            data.linkedWorkItem = linkedWorkItem
            data.prefilledName =
              getLinkedWorkItemWorkspaceName(linkedWorkItem)?.seedName ??
              getLinkedWorkItemSuggestedName({ title: item.title })
          } else {
            data.prefilledName = trimmed
          }
          queueMicrotask(() =>
            openModal('new-workspace-composer', { ...data, telemetrySource: 'command_palette' })
          )
        })
        .catch(() => {
          if (!createLookupGuard.isCurrent(lookupToken)) {
            return
          }
          queueMicrotask(() =>
            openModal('new-workspace-composer', {
              initialRepoId: repoForLookup.id,
              prefilledName: trimmed,
              telemetrySource: 'command_palette'
            })
          )
        })
      return
    }

    // Case 3: plain name — open composer prefilled.
    openComposer(trimmed ? { prefilledName: trimmed } : {})
  }, [
    allWorktrees,
    closeModal,
    createLookupGuard,
    createWorktreeName,
    openModal,
    prefetchCreateWorkspaceBaseForComposer,
    recordFeatureInteraction,
    repoMap
  ])

  const handleCloseAutoFocus = useCallback((e: Event) => {
    e.preventDefault()
  }, [])

  const handleOpenAutoFocus = useCallback((_event: Event) => {
    // No-op: address-bar detection is handled in the visible effect before
    // Radix steals focus. This callback exists only to satisfy the prop API.
  }, [])

  const resultCount = selectableItems.length
  const emptyState = (() => {
    if (
      (hasAnySearchableWorktrees ||
        hasAnyProjectSearchCandidates ||
        hasAnyMiddleResults ||
        hasAnyOpenTabs) &&
      hasQuery
    ) {
      return {
        title: translate(
          'auto.components.WorktreeJumpPalette.dbd9d87eec',
          'No results match your search'
        ),
        subtitle: translate(
          'auto.components.WorktreeJumpPalette.c4afa68159',
          'Try a worktree, project, setting, action, tab title, agent prompt, URL, PR, or port.'
        )
      }
    }
    // Why: empty-query rows exclude the current worktree, so a single-worktree
    // setup has hasAnyWorktrees=true but zero switchable rows. Without this
    // branch the palette would claim "No active worktrees" while one is open
    // — misleading. See docs/cmd-j-empty-query-ordering.md.
    if (!hasQuery && hasAnyWorktrees && !hasAnyOpenTabs) {
      return {
        title: translate(
          'auto.components.WorktreeJumpPalette.f60f8730be',
          'No other worktrees to switch to'
        ),
        subtitle: translate(
          'auto.components.WorktreeJumpPalette.b781ae05e3',
          'Type to search worktrees, settings, tabs, and actions.'
        )
      }
    }
    return {
      title: translate(
        'auto.components.WorktreeJumpPalette.1628fd7dfa',
        'No active worktrees, settings, actions, or open tabs'
      ),
      subtitle: translate(
        'auto.components.WorktreeJumpPalette.f7fda8d562',
        'Create a worktree or open a tab in Orca to get started.'
      )
    }
  })()

  return (
    <CommandDialog
      open={visible}
      onOpenChange={handleOpenChange}
      shouldFilter={false}
      onOpenAutoFocus={handleOpenAutoFocus}
      onCloseAutoFocus={handleCloseAutoFocus}
      title={translate('auto.components.WorktreeJumpPalette.4ee378034d', 'Jump to...')}
      description={translate(
        'auto.components.WorktreeJumpPalette.4e4ff044d5',
        'Search worktrees, settings, tabs, and actions'
      )}
      overlayClassName="bg-black/55 backdrop-blur-[2px]"
      contentClassName="top-[13%] w-[736px] max-w-[94vw] overflow-hidden rounded-xl border border-border/70 bg-background/96 shadow-[0_26px_84px_rgba(0,0,0,0.32)] backdrop-blur-xl"
      commandProps={{
        loop: true,
        value: commandSelectedItemId,
        onValueChange: setSelectedItemId,
        className: 'bg-transparent'
      }}
    >
      <CommandInput
        placeholder={translate(
          'auto.components.WorktreeJumpPalette.1ebe225fee',
          'Search worktrees, settings, tabs, and actions...'
        )}
        value={query}
        onValueChange={handleQueryChange}
        wrapperClassName="mx-3 mt-3 rounded-lg border border-border/55 bg-muted/28 px-3.5 shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]"
        iconClassName="mr-2.5 h-4 w-4 text-muted-foreground/60"
        className="h-12 text-[14px] placeholder:text-muted-foreground/75"
      />
      <CommandList ref={listRef} className="max-h-[min(460px,62vh)] px-2.5 pb-2.5 pt-2">
        {isLoading && selectableItems.length === 0 && !showCreateAction ? (
          <PaletteState
            title={translate(
              'auto.components.WorktreeJumpPalette.ff908adfe9',
              'Loading jump targets'
            )}
            subtitle={translate(
              'auto.components.WorktreeJumpPalette.684e8d7bc2',
              'Gathering your recent worktrees and open tabs.'
            )}
          />
        ) : selectableItems.length === 0 && !showCreateAction ? (
          <CommandEmpty className="py-0">
            <PaletteState title={emptyState.title} subtitle={emptyState.subtitle} />
          </CommandEmpty>
        ) : (
          <>
            {listEntries.map((entry) => {
              if (entry.type === 'section-header') {
                return (
                  <div
                    key={entry.id}
                    className="mx-0.5 mt-3 mb-1 px-3 text-[11px] font-medium uppercase tracking-wider text-muted-foreground/70"
                  >
                    {entry.label}
                  </div>
                )
              }

              if (entry.type === 'hint') {
                // Why: plain div (not CommandItem) so cmdk can't land selection
                // on it and arrow keys skip over it naturally via selectableItems.
                return (
                  <div
                    key={entry.id}
                    className="mx-0.5 mt-1 px-3 py-1.5 text-[12px] italic text-muted-foreground/70"
                  >
                    {entry.label}
                  </div>
                )
              }

              if (entry.type === 'create-worktree') {
                return (
                  <CommandItem
                    key={entry.id}
                    value={CREATE_WORKTREE_ITEM_ID}
                    onSelect={handleCreateWorktree}
                    className="group mx-0.5 mt-1 flex cursor-pointer items-center gap-3 rounded-lg border border-transparent px-3 py-1.5 text-left outline-none transition-[background-color,border-color,box-shadow] data-[selected=true]:border-border data-[selected=true]:bg-accent data-[selected=true]:text-foreground"
                  >
                    <div className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full border border-dashed border-border/60 bg-muted/25 text-muted-foreground/70">
                      <Plus size={13} aria-hidden="true" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="text-[14px] font-semibold tracking-[-0.01em] text-foreground">
                        {translate(
                          'auto.components.WorktreeJumpPalette.95be6587d3',
                          'Create worktree "{{value0}}"',
                          { value0: createWorktreeName }
                        )}
                      </div>
                    </div>
                  </CommandItem>
                )
              }

              if (entry.type === 'worktree') {
                const worktree = entry.worktree
                const repo = repoMap.get(worktree.repoId)
                const repoName = repo?.displayName ?? ''
                const branch = branchName(worktree.branch)
                const status = getWorktreeStatus(
                  tabsByWorktree[worktree.id] ?? [],
                  browserTabsByWorktree[worktree.id] ?? [],
                  ptyIdsByTabId,
                  runtimePaneTitlesByTabId,
                  { liveAgentStatus: liveAgentActivity.statusByWorktreeId.get(worktree.id) }
                )
                const statusLabel = getWorktreeStatusLabel(status)
                const isCurrentWorktree = activeWorktreeId === worktree.id
                // Runtime-owned (per-workspace-env) SSH targets are hidden and their relay health is
                // owned by the runtime layer (broadcasts suppressed) — don't show a false disconnected.
                const sshConnectionId =
                  repo?.connectionId && !isRuntimeOwnedSshTargetId(repo.connectionId)
                    ? repo.connectionId
                    : null
                const sshStatus = sshConnectionId
                  ? (sshConnectionStates.get(sshConnectionId)?.status ?? 'disconnected')
                  : null
                const isSshDisconnected = sshStatus != null && sshStatus !== 'connected'
                const hostBadge = getPaletteHostBadge(repo, hostOptions)

                return (
                  <CommandItem
                    key={entry.id}
                    value={entry.id}
                    onSelect={() => handleSelectItem(entry)}
                    data-current={isCurrentWorktree ? 'true' : undefined}
                    className={cn(
                      'group mx-0.5 flex cursor-pointer items-center gap-3 rounded-lg border border-transparent px-3 py-2.5 text-left outline-none transition-[background-color,border-color,box-shadow]',
                      'data-[selected=true]:border-border data-[selected=true]:bg-accent data-[selected=true]:text-foreground'
                    )}
                  >
                    <div className="flex w-4 shrink-0 items-center justify-center self-start pt-0.5">
                      <StatusIndicator status={status} aria-hidden="true" />
                      <span className="sr-only">{statusLabel}</span>
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center justify-between gap-2.5">
                        <div className="min-w-0 flex-1">
                          <div className="flex min-w-0 items-center gap-2">
                            {sshConnectionId && (
                              <span
                                aria-label={
                                  isSshDisconnected
                                    ? translate(
                                        'auto.components.WorktreeJumpPalette.63c2be1914',
                                        'SSH disconnected'
                                      )
                                    : translate(
                                        'auto.components.WorktreeJumpPalette.34c8fbb46e',
                                        'SSH remote'
                                      )
                                }
                                className="shrink-0 inline-flex items-center"
                              >
                                {isSshDisconnected ? (
                                  <ServerOff className="size-3.5 text-red-400" aria-hidden="true" />
                                ) : (
                                  <Server
                                    className="size-3.5 text-muted-foreground"
                                    aria-hidden="true"
                                  />
                                )}
                              </span>
                            )}
                            <span className="truncate text-[14px] font-semibold text-foreground">
                              {entry.match.displayNameRange ? (
                                <HighlightedText
                                  text={worktree.displayName}
                                  matchRange={entry.match.displayNameRange}
                                />
                              ) : (
                                worktree.displayName
                              )}
                            </span>
                            {isCurrentWorktree && (
                              <span className="shrink-0 self-center rounded-[6px] border border-border/60 bg-background/45 px-1.5 py-px text-[9px] font-medium leading-normal text-muted-foreground/88">
                                {translate(
                                  'auto.components.WorktreeJumpPalette.556e7232ca',
                                  'Current'
                                )}
                              </span>
                            )}
                            {worktree.isMainWorktree && (
                              <span className="shrink-0 self-center rounded border border-muted-foreground/30 bg-muted-foreground/5 px-1.5 py-px text-[9px] font-medium leading-normal text-muted-foreground">
                                {translate(
                                  'auto.components.WorktreeJumpPalette.739bda980c',
                                  'primary'
                                )}
                              </span>
                            )}
                            <span className="shrink-0 text-muted-foreground/45">·</span>
                            <span className="truncate text-[12px] font-medium text-muted-foreground/92">
                              {entry.match.branchRange ? (
                                <HighlightedText
                                  text={branch}
                                  matchRange={entry.match.branchRange}
                                />
                              ) : (
                                branch
                              )}
                            </span>
                          </div>
                          {entry.match.supportingText && (
                            <div className="mt-1.5 flex min-w-0 items-center gap-2 text-[12px] leading-5 text-muted-foreground/88">
                              <span className="inline-flex h-[18px] shrink-0 items-center rounded border border-border bg-foreground/[0.04] px-1.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                                {getPaletteSupportingTextLabel(
                                  entry.match.supportingText.labelKind
                                )}
                              </span>
                              <span className="truncate">
                                <HighlightedText
                                  text={entry.match.supportingText.text}
                                  matchRange={entry.match.supportingText.matchRange}
                                />
                              </span>
                            </div>
                          )}
                        </div>
                        <div className="flex shrink-0 items-center gap-1.5">
                          <PaletteHostBadgeChip badge={hostBadge} />
                          {repoName && (
                            <span className="inline-flex max-w-[180px] items-center gap-1.5 rounded-md border border-border bg-muted px-2 py-1 text-[11px] font-semibold leading-none text-foreground">
                              <RepoBadgeMark color={repo?.badgeColor} />
                              <span className="truncate">
                                {entry.match.repoRange ? (
                                  <HighlightedText
                                    text={repoName}
                                    matchRange={entry.match.repoRange}
                                  />
                                ) : (
                                  repoName
                                )}
                              </span>
                            </span>
                          )}
                        </div>
                      </div>
                    </div>
                  </CommandItem>
                )
              }

              if (entry.type === 'project-target') {
                const result = entry.result
                const isProject = result.kind === 'project'
                const hostBadge = isProject ? getPaletteHostBadge(result.repo, hostOptions) : null
                const badgeLabel = isProject
                  ? translate('auto.components.WorktreeJumpPalette.projectBadge', 'Project')
                  : translate('auto.components.WorktreeJumpPalette.repoGroupBadge', 'Repo group')
                return (
                  <CommandItem
                    key={entry.id}
                    value={entry.id}
                    onSelect={() => handleSelectItem(entry)}
                    className={cn(
                      'group mx-0.5 flex cursor-pointer items-center gap-3 rounded-lg border border-transparent px-3 py-2.5 text-left outline-none transition-[background-color,border-color,box-shadow]',
                      'data-[selected=true]:border-border data-[selected=true]:bg-accent data-[selected=true]:text-foreground'
                    )}
                  >
                    <div className="flex w-4 shrink-0 items-center justify-center self-start pt-0.5 text-muted-foreground/85">
                      <FolderTree className="size-3.5" aria-hidden="true" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center justify-between gap-2.5">
                        <div className="min-w-0 flex-1">
                          <div className="flex min-w-0 items-center gap-2">
                            <span className="truncate text-[14px] font-semibold text-foreground">
                              {result.title}
                            </span>
                            <span className="shrink-0 rounded-[6px] border border-border/60 bg-background/45 px-1.5 py-px text-[9px] font-medium leading-normal text-muted-foreground/88">
                              {badgeLabel}
                            </span>
                          </div>
                        </div>
                        {isProject ? (
                          <div className="flex shrink-0 items-center gap-1.5">
                            <PaletteHostBadgeChip badge={hostBadge} />
                            <span className="inline-flex max-w-[180px] items-center gap-1.5 rounded-md border border-border bg-muted px-2 py-1 text-[11px] font-semibold leading-none text-foreground">
                              <RepoBadgeMark color={result.repo.badgeColor} />
                              <span className="truncate">{result.repo.displayName}</span>
                            </span>
                          </div>
                        ) : null}
                      </div>
                    </div>
                  </CommandItem>
                )
              }

              if (entry.type === 'settings' || entry.type === 'quick-action') {
                const result = entry.result
                const Icon = result.icon
                const kindLabel =
                  entry.type === 'settings'
                    ? translate('auto.components.WorktreeJumpPalette.settingsBadge', 'Settings')
                    : translate('auto.components.WorktreeJumpPalette.actionBadge', 'Action')
                return (
                  <CommandItem
                    key={entry.id}
                    value={entry.id}
                    onSelect={() => handleSelectItem(entry)}
                    className={cn(
                      'group mx-0.5 flex cursor-pointer items-center gap-3 rounded-lg border border-transparent px-3 py-2.5 text-left outline-none transition-[background-color,border-color,box-shadow]',
                      'data-[selected=true]:border-border data-[selected=true]:bg-accent data-[selected=true]:text-foreground'
                    )}
                  >
                    <div className="flex w-4 shrink-0 items-center justify-center self-start pt-0.5 text-muted-foreground/85">
                      <Icon className="size-3.5" aria-hidden="true" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex min-w-0 items-center gap-2">
                        <span className="truncate text-[14px] font-semibold tracking-[-0.01em] text-foreground">
                          {result.title}
                        </span>
                        <span className="shrink-0 rounded-[6px] border border-border/60 bg-background/45 px-1.5 py-px text-[9px] font-medium leading-normal text-muted-foreground/88">
                          {kindLabel}
                        </span>
                      </div>
                      <div className="mt-1 truncate text-[12px] leading-5 text-muted-foreground/88">
                        {result.description}
                      </div>
                    </div>
                  </CommandItem>
                )
              }

              if (entry.type === 'workspace-tab') {
                const result = entry.result
                const workspaceTabWorktree = worktreeMap.get(result.worktreeId)
                const workspaceTabRepo = workspaceTabWorktree
                  ? repoMap.get(workspaceTabWorktree.repoId)
                  : undefined
                const workspaceTabRepoName = workspaceTabRepo?.displayName ?? result.repoName
                const workspaceTabHostBadge = getPaletteHostBadge(workspaceTabRepo, hostOptions)
                const WorkspaceTabIcon =
                  result.contentType === 'terminal' ? SquareTerminal : FileText

                return (
                  <CommandItem
                    key={entry.id}
                    value={entry.id}
                    onSelect={() => handleSelectItem(entry)}
                    className={cn(
                      'group mx-0.5 flex cursor-pointer items-center gap-3 rounded-lg border border-transparent px-3 py-2.5 text-left outline-none transition-[background-color,border-color,box-shadow]',
                      'data-[selected=true]:border-border data-[selected=true]:bg-accent data-[selected=true]:text-foreground'
                    )}
                  >
                    <div className="flex w-4 shrink-0 items-center justify-center self-start pt-0.5 text-muted-foreground/85">
                      <WorkspaceTabIcon className="size-3.5" aria-hidden="true" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center justify-between gap-2.5">
                        <div className="min-w-0 flex-1">
                          <div className="flex min-w-0 items-center gap-2">
                            <span className="max-w-[40%] shrink-0 truncate text-[14px] font-semibold tracking-[-0.01em] text-foreground">
                              <HighlightedText text={result.title} matchRange={result.titleRange} />
                            </span>
                            {result.isCurrentTab && (
                              <span className="shrink-0 self-center rounded-[6px] border border-border/60 bg-background/45 px-1.5 py-px text-[9px] font-medium leading-normal text-muted-foreground/88">
                                {translate(
                                  'auto.components.WorktreeJumpPalette.52404f8096',
                                  'Current Tab'
                                )}
                              </span>
                            )}
                            {!result.isCurrentTab && result.isCurrentWorktree && (
                              <span className="shrink-0 self-center rounded-[6px] border border-border/60 bg-background/45 px-1.5 py-px text-[9px] font-medium leading-normal text-muted-foreground/88">
                                {translate(
                                  'auto.components.WorktreeJumpPalette.c5081f2814',
                                  'Current Worktree'
                                )}
                              </span>
                            )}
                            <span className="shrink-0 text-muted-foreground/45">·</span>
                            <span className="min-w-0 truncate text-[12px] font-medium text-muted-foreground/92">
                              <HighlightedText
                                text={result.secondaryText}
                                matchRange={result.secondaryRange}
                              />
                            </span>
                            <span className="shrink-0 text-muted-foreground/45">·</span>
                            <span className="shrink-0 text-[12px] font-medium text-muted-foreground/92">
                              <HighlightedText
                                text={result.worktreeName}
                                matchRange={result.worktreeRange}
                              />
                            </span>
                          </div>
                        </div>
                        <div className="flex shrink-0 items-center gap-1.5">
                          <PaletteHostBadgeChip badge={workspaceTabHostBadge} />
                          {workspaceTabRepoName && (
                            <span className="inline-flex max-w-[180px] items-center gap-1.5 rounded-md border border-border bg-muted px-2 py-1 text-[11px] font-semibold leading-none text-foreground">
                              <RepoBadgeMark color={workspaceTabRepo?.badgeColor} />
                              <span className="truncate">
                                <HighlightedText
                                  text={workspaceTabRepoName}
                                  matchRange={result.repoRange}
                                />
                              </span>
                            </span>
                          )}
                        </div>
                      </div>
                    </div>
                  </CommandItem>
                )
              }

              if (entry.type === 'simulator-tab') {
                const result = entry.result
                const simulatorWorktree = worktreeMap.get(result.worktreeId)
                const simulatorRepo = simulatorWorktree
                  ? repoMap.get(simulatorWorktree.repoId)
                  : undefined
                const simulatorRepoName = simulatorRepo?.displayName ?? result.repoName
                const simulatorHostBadge = getPaletteHostBadge(simulatorRepo, hostOptions)

                return (
                  <CommandItem
                    key={entry.id}
                    value={entry.id}
                    onSelect={() => handleSelectItem(entry)}
                    className={cn(
                      'group mx-0.5 flex cursor-pointer items-center gap-3 rounded-lg border border-transparent px-3 py-2.5 text-left outline-none transition-[background-color,border-color,box-shadow]',
                      'data-[selected=true]:border-border data-[selected=true]:bg-accent data-[selected=true]:text-foreground'
                    )}
                  >
                    <div className="flex w-4 shrink-0 items-center justify-center self-start pt-0.5 text-muted-foreground/85">
                      <Smartphone className="size-3.5" aria-hidden="true" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center justify-between gap-2.5">
                        <div className="min-w-0 flex-1">
                          <div className="flex min-w-0 items-center gap-2">
                            <span className="max-w-[40%] shrink-0 truncate text-[14px] font-semibold tracking-[-0.01em] text-foreground">
                              <HighlightedText text={result.title} matchRange={result.titleRange} />
                            </span>
                            {result.isCurrentTab && (
                              <span className="shrink-0 self-center rounded-[6px] border border-border/60 bg-background/45 px-1.5 py-px text-[9px] font-medium leading-normal text-muted-foreground/88">
                                {translate(
                                  'auto.components.WorktreeJumpPalette.52404f8096',
                                  'Current Tab'
                                )}
                              </span>
                            )}
                            {!result.isCurrentTab && result.isCurrentWorktree && (
                              <span className="shrink-0 self-center rounded-[6px] border border-border/60 bg-background/45 px-1.5 py-px text-[9px] font-medium leading-normal text-muted-foreground/88">
                                {translate(
                                  'auto.components.WorktreeJumpPalette.c5081f2814',
                                  'Current Worktree'
                                )}
                              </span>
                            )}
                            <span className="shrink-0 text-muted-foreground/45">·</span>
                            <span className="min-w-0 truncate text-[12px] font-medium text-muted-foreground/92">
                              <HighlightedText
                                text={result.secondaryText}
                                matchRange={result.secondaryRange}
                              />
                            </span>
                            <span className="shrink-0 text-muted-foreground/45">·</span>
                            <span className="shrink-0 text-[12px] font-medium text-muted-foreground/92">
                              <HighlightedText
                                text={result.worktreeName}
                                matchRange={result.worktreeRange}
                              />
                            </span>
                          </div>
                        </div>
                        <div className="flex shrink-0 items-center gap-1.5">
                          <PaletteHostBadgeChip badge={simulatorHostBadge} />
                          {simulatorRepoName && (
                            <span className="inline-flex max-w-[180px] items-center gap-1.5 rounded-md border border-border bg-muted px-2 py-1 text-[11px] font-semibold leading-none text-foreground">
                              <RepoBadgeMark color={simulatorRepo?.badgeColor} />
                              <span className="truncate">
                                <HighlightedText
                                  text={simulatorRepoName}
                                  matchRange={result.repoRange}
                                />
                              </span>
                            </span>
                          )}
                        </div>
                      </div>
                    </div>
                  </CommandItem>
                )
              }

              const result = entry.result
              const browserWorktree = worktreeMap.get(result.worktreeId)
              const browserRepo = browserWorktree ? repoMap.get(browserWorktree.repoId) : undefined
              const browserRepoName = browserRepo?.displayName ?? result.repoName
              const browserHostBadge = getPaletteHostBadge(browserRepo, hostOptions)

              return (
                <CommandItem
                  key={entry.id}
                  value={entry.id}
                  onSelect={() => handleSelectItem(entry)}
                  className={cn(
                    'group mx-0.5 flex cursor-pointer items-center gap-3 rounded-lg border border-transparent px-3 py-2.5 text-left outline-none transition-[background-color,border-color,box-shadow]',
                    'data-[selected=true]:border-border data-[selected=true]:bg-accent data-[selected=true]:text-foreground'
                  )}
                >
                  <div className="flex w-4 shrink-0 items-center justify-center self-start pt-0.5 text-muted-foreground/85">
                    <Globe className="size-3.5" aria-hidden="true" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center justify-between gap-2.5">
                      <div className="min-w-0 flex-1">
                        <div className="flex min-w-0 items-center gap-2">
                          <span className="max-w-[40%] shrink-0 truncate text-[14px] font-semibold tracking-[-0.01em] text-foreground">
                            <HighlightedText text={result.title} matchRange={result.titleRange} />
                          </span>
                          {result.isCurrentPage && (
                            <span className="shrink-0 self-center rounded-[6px] border border-border/60 bg-background/45 px-1.5 py-px text-[9px] font-medium leading-normal text-muted-foreground/88">
                              {translate(
                                'auto.components.WorktreeJumpPalette.52404f8096',
                                'Current Tab'
                              )}
                            </span>
                          )}
                          {!result.isCurrentPage && result.isCurrentWorktree && (
                            <span className="shrink-0 self-center rounded-[6px] border border-border/60 bg-background/45 px-1.5 py-px text-[9px] font-medium leading-normal text-muted-foreground/88">
                              {translate(
                                'auto.components.WorktreeJumpPalette.c5081f2814',
                                'Current Worktree'
                              )}
                            </span>
                          )}
                          <span className="shrink-0 text-muted-foreground/45">·</span>
                          <span className="min-w-0 truncate text-[12px] font-medium text-muted-foreground/92">
                            <HighlightedText
                              text={result.secondaryText}
                              matchRange={result.secondaryRange}
                            />
                          </span>
                          <span className="shrink-0 text-muted-foreground/45">·</span>
                          <span className="shrink-0 text-[12px] font-medium text-muted-foreground/92">
                            <HighlightedText
                              text={result.worktreeName}
                              matchRange={result.worktreeRange}
                            />
                          </span>
                        </div>
                      </div>
                      <div className="flex shrink-0 items-center gap-1.5">
                        <PaletteHostBadgeChip badge={browserHostBadge} />
                        {browserRepoName && (
                          <span className="inline-flex max-w-[180px] items-center gap-1.5 rounded-md border border-border bg-muted px-2 py-1 text-[11px] font-semibold leading-none text-foreground">
                            <RepoBadgeMark color={browserRepo?.badgeColor} />
                            <span className="truncate">
                              <HighlightedText
                                text={browserRepoName}
                                matchRange={result.repoRange}
                              />
                            </span>
                          </span>
                        )}
                      </div>
                    </div>
                  </div>
                </CommandItem>
              )
            })}
          </>
        )}
      </CommandList>
      <div className="flex items-center justify-end border-t border-border/60 px-3.5 py-2.5 text-[11px] text-muted-foreground/82">
        <div className="flex items-center gap-2">
          <FooterKey>
            {translate('auto.components.WorktreeJumpPalette.f65d992a11', 'Enter')}
          </FooterKey>
          <span>{translate('auto.components.WorktreeJumpPalette.45def60329', 'Open')}</span>
          <FooterKey>
            {translate('auto.components.WorktreeJumpPalette.66b5a67bee', 'Esc')}
          </FooterKey>
          <span>{translate('auto.components.WorktreeJumpPalette.75499e01d9', 'Close')}</span>
          <FooterKey>↑↓</FooterKey>
          <span>{translate('auto.components.WorktreeJumpPalette.ac037cfac2', 'Move')}</span>
        </div>
      </div>
      <div aria-live="polite" className="sr-only">
        {deferredQuery.trim()
          ? translate(
              'auto.components.WorktreeJumpPalette.bb72c08e63',
              '{{value0}} results found{{value1}}',
              {
                value0: resultCount,
                value1: showCreateAction ? ', create worktree action available' : ''
              }
            )
          : translate(
              'auto.components.WorktreeJumpPalette.20af998bff',
              '{{value0}} items available{{value1}}',
              {
                value0: resultCount,
                value1: showCreateAction ? ', create worktree action available' : ''
              }
            )}
      </div>
    </CommandDialog>
  )
}

function getPaletteSupportingTextLabel(
  labelKind: NonNullable<PaletteSearchResult['supportingText']>['labelKind']
): string {
  switch (labelKind) {
    case 'comment':
      return translate('worktreeJumpPalette.matchLabel.comment', 'Comment')
    case 'issue':
      return translate('worktreeJumpPalette.matchLabel.issue', 'Issue')
    case 'port':
      return translate('worktreeJumpPalette.matchLabel.port', 'Port')
    case 'pr':
      return translate('worktreeJumpPalette.matchLabel.pr', 'PR')
  }
}
