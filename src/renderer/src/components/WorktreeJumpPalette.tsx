/* oxlint-disable max-lines */
import React, {
  useCallback,
  useDeferredValue,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState
} from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import {
  FileText,
  FolderTree,
  Globe,
  Server,
  ServerOff,
  Smartphone,
  SquareTerminal
} from 'lucide-react'
import { useAppStore } from '@/store'
import { getRepoMapFromState, useAllWorktrees } from '@/store/selectors'
import {
  selectPaletteIndexStatusSnapshot,
  selectPaletteStatusInputs
} from './worktree-jump-palette-status-inputs'
import {
  PaletteLiveStatusProvider,
  PaletteRecentTabStatusDot,
  PaletteWorktreeStatusDot
} from './cmd-j/palette-live-status'
import {
  resolveTerminalTabAttentionBadge,
  terminalTabHasUnreadActivity
} from '@/components/tab-bar/terminal-tab-activity-status'
import {
  CommandDialog,
  CommandInput,
  CommandList,
  CommandEmpty,
  CommandItem
} from '@/components/ui/command'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { parseGitHubIssueOrPRNumber, parseGitHubIssueOrPRLink } from '@/lib/github-links'
import { getLinkedWorkItemSuggestedName, getLinkedWorkItemWorkspaceName } from '@/lib/new-workspace'
import type { LinkedWorkItemSummary } from '@/lib/new-workspace'
import { sortWorktreesSmart } from '@/components/sidebar/smart-sort'
import {
  isAutomationGeneratedWorkspace,
  isCliCreatedWorkspace,
  isDetachedHeadWorkspace,
  isSleepingSweepExemptWorkspace
} from '@/components/sidebar/visible-worktrees'
import { isDefaultBranchWorkspace } from '@/components/sidebar/default-branch-workspace'
import {
  EMPTY_PAIRED_DEVICE_IDS_BY_ENVIRONMENT,
  getPairedDeviceIdsByEnvironment,
  isWorkspaceFromOtherDevice
} from '@/components/sidebar/workspace-creator-visibility'
import { getLiveAgentStatusByWorktreeId, isInactiveWorkspace } from '@/lib/worktree-activity-state'
import { orderEmptyQueryWorktrees } from '@/lib/order-empty-query-worktrees'
import {
  bestPaletteQualityRank,
  comparePaletteRankedItems,
  shouldIntentSectionLeadPaletteSections,
  shouldOpenTabsLeadPaletteSections,
  NO_PALETTE_QUALITY_RANK
} from '@/lib/cmd-j-section-leadership'
import { AgentIcon } from '@/lib/agent-catalog'
import { cn } from '@/lib/utils'
import { activateAndRevealWorktree } from '@/lib/worktree-activation'
import { queueWorkspaceActivationTerminalFocus } from '@/lib/workspace-activation-terminal-focus'
import {
  getWorktreePaletteSearchScope,
  searchWorktreeDocuments,
  type MatchRange,
  type PaletteSearchResult
} from '@/lib/worktree-palette-search'
import { buildWorktreePaletteDocuments } from '@/lib/worktree-palette-document'
import {
  resolveWorktreeBranchLabel,
  resolveWorktreeDisplayName
} from '@/lib/worktree-default-display-name'
import {
  CREATE_WORKTREE_ITEM_ID,
  createWorktreePaletteRequestGuard,
  getNextWorktreePaletteSelection,
  getWorktreePaletteSelectionItemIds,
  getWorktreePaletteCreateActionState,
  isWorktreePaletteCreateActivationAllowed,
  WORKTREE_PALETTE_SELECTION_MOVE_KEYS,
  type WorktreePaletteRequestGuard
} from '@/lib/worktree-palette-create-action'
import { getWorkspacePortsByWorktreeId } from '@/lib/workspace-port-groups'
import {
  searchBrowserPages,
  type BrowserPaletteSearchResult,
  type SearchableBrowserPage
} from '@/lib/browser-palette-search'
import { buildSearchableBrowserPages } from '@/lib/browser-palette-page-entries'
import {
  buildPaletteWorktreeIndex,
  isPaletteCurrentWorktree,
  resolvePaletteRepoForWorktree,
  resolvePaletteWorktree
} from '@/lib/palette-repo-resolution'
import { activateBrowserPagePaletteResult } from '@/lib/browser-page-palette-activation'
import { activateSimulatorTabPaletteResult } from '@/lib/simulator-tab-palette-activation'
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
  buildExplicitEntriesByTabId,
  type TabPaneInputSources
} from '@/components/sidebar/smart-attention'
import {
  buildFocusedGroupTabRecency,
  orderRecentWorkspaceTabs,
  resolveRecentWorkspaceTabStatus,
  type RecentWorkspaceTabRow
} from '@/lib/recent-workspace-tab-rows'
import { subscribeCmdJRowIndexJump } from '@/lib/cmd-j-row-index-jump'
import { ShortcutKeyCombo } from '@/components/ShortcutKeyCombo'
import { useShortcutKeyComboDetails } from '@/hooks/useShortcutLabel'
import {
  ORCA_BROWSER_FOCUS_REQUEST_EVENT,
  queueBrowserFocusRequest
} from '@/components/browser-pane/host-guest/browser-focus'
import { RepoBadgeMark } from '@/components/repo/RepoBadgeLabel'
import { buildSidebarHostOptions } from '@/components/sidebar/sidebar-host-options'
import { getPaletteHostBadge } from '@/components/cmd-j/palette-host-badge'
import { getWorktreeHostIdentity } from '../../../shared/worktree/host-qualified-identity'
import { getRepoHostIdentity } from '@/store/slices/repo-host-identity'
import type { Repo } from '../../../shared/repo-types'
import {
  getSettingsFocusedExecutionHostId,
  isRuntimeOwnedSshTargetId,
  type ExecutionHostId
} from '../../../shared/execution-host'
import { buildPaletteListEntryRenderKeys } from '@/components/cmd-j/palette-list-entry-render-keys'
import { formatPaletteSessionAge } from '@/components/cmd-j/palette-session-age'
import PaletteFilterMenu from '@/components/cmd-j/PaletteFilterMenu'
import PaletteFilterChips from '@/components/cmd-j/PaletteFilterChips'
import { buildPaletteFilterModel } from '@/components/cmd-j/palette-filter-options'
import { getProjectGroupExecutionHostIdForRows } from '@/components/sidebar/worktree-list/listing/host-filtering'
import {
  buildPaletteFilterPredicate,
  EMPTY_PALETTE_FILTER,
  getPaletteFilterSelectionCount,
  isPaletteFilterActive,
  reconcilePaletteFilter,
  type PaletteFilterState
} from '@/components/cmd-j/palette-filter'
import {
  capPaletteSection,
  layoutMultiPrimaryPaletteSections,
  PALETTE_SECTION_EXPAND_STEP,
  PALETTE_SECTION_RENDER_CAP,
  TYPED_QUERY_LEADING_PREVIEW
} from '@/components/cmd-j/palette-section-render-cap'
import { useSettingsNavigationMetadata } from '@/hooks/useSettingsNavigationMetadata'
import { runWorktreeDelete } from '@/components/sidebar/delete-worktree-flow'
import {
  buildCmdJActionResults,
  buildCmdJSettingsResults,
  bestCmdJPaletteSectionQualityClass,
  rankCmdJMiddleResults,
  type CmdJRankedMiddleResult,
  type CmdJActionResult,
  type CmdJSettingsResult
} from '@/components/cmd-j/palette-results'
import { buildImportedWorktreesCardCandidates } from '@/components/sidebar/imported-worktrees-card-candidates'
import {
  hasCmdJProjectSearchCandidates,
  searchCmdJProjectResults,
  type CmdJProjectSearchResult,
  type CmdJRankedProjectSearchResult
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
import { buildWorktreeChecksReviewIndex } from '@/components/cmd-j/worktree-checks-review-index'
import { resolvePaletteFocusRestoreTarget } from '@/components/cmd-j/palette-focus-restore-target'
import { selectWorktreePaletteCacheInputs } from '@/components/cmd-j/worktree-palette-cache-inputs'
import { buildPluginQuickActions } from '@/components/cmd-j/plugin-quick-actions'
import { PaletteCreateWorktreeRow } from '@/components/cmd-j/PaletteCreateWorktreeRow'
import { WorkspaceEmojiSuggestionPopover } from '@/components/workspace-emoji/WorkspaceEmojiSuggestionPopover'
import { useWorkspaceEmojiShortcodeInput } from '@/components/workspace-emoji/useWorkspaceEmojiShortcodeInput'
import { usePluginCommands } from '@/store/plugin-panels'
import {
  getComposerEligibleRepos,
  resolveComposerActiveRepoId,
  resolveComposerGitRepoId
} from '@/lib/new-workspace-composer-repo'
import { resolveWorkspaceCreationTarget } from '@/lib/project-host-workspace-target'
import { lookupGitHubWorkItemForSource } from '@/lib/github-work-item-source-lookup'
import { lookupCmdJGitHubUrlWorkItem } from '@/lib/cmd-j-github-url-lookup'
import { buildLinearIssueLinkedWorkItem } from '@/lib/linear-linked-work-item'
import { lookupLinearIssueUrl } from '@/lib/linear-issue-url-lookup'
import {
  getCmdJTaskUrlCreatePreview,
  parseCmdJTaskSourceUrl,
  withResolvedCmdJGitHubPreview
} from '@/lib/worktree-palette-task-url-match'
import type { SettingsNavTarget } from '@/lib/settings-navigation-types'
import { getHostDisplayLabelOverrides } from '../../../shared/host-setting-overrides'
import type { GitHubWorkItem } from '../../../shared/github/work-item-types'
import type { LinearIssue } from '../../../shared/linear/issue-types'
import type { WorkspaceVisibleTabType } from '../../../shared/tab-types'
import type { TerminalTab } from '../../../shared/terminal-tab-types'
import type { Worktree } from '../../../shared/worktree/types'
import { isGitRepoKind } from '../../../shared/repo-kind'
import {
  buildTaskSourceContextFromRepo,
  normalizeTaskSourceContext,
  type TaskSourceContext
} from '../../../shared/task-source-context'
import { getLinearIssueWorkspaceName } from '../../../shared/workspace-name'
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
  result: CmdJSettingsResult & Pick<CmdJRankedMiddleResult, 'qualityClass'>
}

type QuickActionPaletteItem = {
  id: string
  type: 'quick-action'
  result: CmdJActionResult & Pick<CmdJRankedMiddleResult, 'qualityClass'>
}

type ProjectTargetPaletteItem = {
  id: string
  type: 'project-target'
  result: CmdJRankedProjectSearchResult
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
  onSeeMore?: () => void
}

type CreateWorktreePaletteItem = {
  id: typeof CREATE_WORKTREE_ITEM_ID
  type: 'create-worktree'
}

type CmdJLinearIssuePreview = {
  query: string
  issue: LinearIssue | null
  loading: boolean
  initialRepoId: string | null
  sourceContext: TaskSourceContext | null
}

type CmdJGitHubWorkItemPreview = {
  query: string
  item: GitHubWorkItem | null
  loading: boolean
  initialRepoId: string | null
  sourceContext: TaskSourceContext | null
}

// Why: keep quick actions curated — Cmd+J is a fast intent surface, not a dump of every setup button.
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

// Why: outlast the CommandDialog close animation so its rows do not disappear mid-fade.
const PALETTE_CLOSE_LINGER_MS = 300
// Why `jump-palette-item`: selection chrome lives in main.css — flat accent is invisible on light popovers.
const JUMP_PALETTE_ITEM_CLASSNAME =
  'jump-palette-item group mx-0.5 flex cursor-pointer items-center gap-3 rounded-lg border border-transparent px-3 text-left outline-none transition-[background-color,box-shadow]'

type OpenTabPaletteItem = BrowserPaletteItem | SimulatorPaletteItem | WorkspaceTabPaletteItem

// Why: while the palette is open the workspace digit chord addresses recent rows, so it labels them.
const DIGIT_INDEX_ACTION_ID = 'workspace.selectByIndex' as const
// Why: this is also the ⌘N ceiling — any deeper and RECENT WORKTREES falls below the first screenful.
const EMPTY_QUERY_RECENT_TAB_CAP = 6
// Why: hold total empty-query rows at the pre-existing 10 so the worktree header stays above the fold.
const EMPTY_QUERY_ROW_BUDGET = 10
const EMPTY_QUERY_WORKTREE_CAP = 5
const EMPTY_RECENT_TAB_ORDER: readonly string[] = []
const EMPTY_SORTED_WORKTREES: Worktree[] = []
const EMPTY_BROWSER_PAGE_ENTRIES: SearchableBrowserPage[] = []
const EMPTY_SIMULATOR_TAB_ENTRIES: SearchableSimulatorTab[] = []
const EMPTY_WORKSPACE_TAB_ENTRIES: SearchableWorkspaceTab[] = []
// Why: the interleaved layout emits a section header twice; the second copy needs a distinct entry id.
const CONTINUED_SECTION_HEADER_ID_SUFFIX = '__continued'

function isCurrentOpenTabItem(item: OpenTabPaletteItem): boolean {
  return item.type === 'browser-page' ? item.result.isCurrentPage : item.result.isCurrentTab
}

/** Not the command id: two hosts — or a duplicate snapshot — can publish the same tab id. */
function getRecentTabOccurrenceBase(item: OpenTabPaletteItem): string {
  if (item.type === 'browser-page') {
    const result = item.result
    return JSON.stringify([
      item.type,
      item.id,
      result.executionHostId ?? '',
      result.worktreeId,
      result.workspaceId,
      result.pageId
    ])
  }
  if (item.type === 'simulator-tab') {
    const result = item.result
    // Why no groupId: it changes when a tab is regrouped mid-open, and the frozen
    // order must keep resolving the row; tabId already identifies it within a host.
    return JSON.stringify([
      item.type,
      item.id,
      result.executionHostId ?? '',
      result.worktreeId,
      result.tabId
    ])
  }
  const result = item.result
  return JSON.stringify([
    item.type,
    item.id,
    result.executionHostId ?? '',
    result.worktreeId,
    result.tabId,
    result.entityId
  ])
}

function buildRecentTabOccurrenceIds(items: readonly OpenTabPaletteItem[]): string[] {
  const nextOrdinalByBase = new Map<string, number>()
  return items.map((item) => {
    const base = getRecentTabOccurrenceBase(item)
    const ordinal = nextOrdinalByBase.get(base) ?? 0
    nextOrdinalByBase.set(base, ordinal + 1)
    return `recent-tab:${base}:${ordinal}`
  })
}

/** An open tab's recent-section row plus the inputs inclusion needs. */
type OpenTabRecentRow = {
  item: OpenTabPaletteItem
  occurrenceId: string
  worktree: Worktree
  row: RecentWorkspaceTabRow
}

/**
 * Empty-query recent section: skip idle "where you already are" rows, but keep the current tab when
 * it still wants something from you (working, permission, unread). Decided from the open-time status
 * snapshot, so membership matches the frozen row order for the whole session — a current tab that
 * goes high-signal mid-open joins Recent on the next open, not under the cursor.
 */
function shouldIncludeOpenTabInRecentSection({
  item,
  worktree,
  row,
  paneSources,
  unreadTerminalTabs,
  unreadAgentCompletionPanes,
  now
}: {
  item: OpenTabPaletteItem
  worktree: Worktree
  row: RecentWorkspaceTabRow
  paneSources: TabPaneInputSources
  unreadTerminalTabs: Record<string, boolean | undefined>
  unreadAgentCompletionPanes: Record<string, boolean | undefined>
  now: number
}): boolean {
  if (worktree.isArchived) {
    return false
  }
  if (!isCurrentOpenTabItem(item)) {
    return true
  }
  // Current browser/editor rows have no attention ladder to escape "you're already here".
  if (!row.terminalTab) {
    return false
  }
  // Why the ladder minus `done`: the badge rungs decide entry, but a completion you watched land on
  // screen (unread auto-acks on the focused tab) is news to nobody, and `done` lingers for the full
  // 30m staleness window — that slot belongs to a workspace you can't already see. Rows admitted
  // while working keep their frozen slot and flip to the check.
  const badge = resolveTerminalTabAttentionBadge({
    status: resolveRecentWorkspaceTabStatus(row, paneSources, now),
    hasUnread: terminalTabHasUnreadActivity({
      terminalTabId: row.terminalTab.id,
      unreadTerminalTabs,
      unreadAgentCompletionPanes
    })
  })
  return badge != null && badge !== 'done' && badge !== 'interrupted'
}

function PaletteRowShortcutBadge({
  index,
  modifierKeys
}: {
  index: number | undefined
  modifierKeys: readonly string[]
}): React.JSX.Element | null {
  if (index === undefined || modifierKeys.length === 0) {
    return null
  }
  return (
    <ShortcutKeyCombo
      keys={[...modifierKeys, String(index + 1)]}
      className="inline-flex gap-0.5"
      keyCapClassName="min-w-4 border-border/60 bg-background/45 px-1 py-px text-[9px] text-muted-foreground/88 shadow-none"
      separatorClassName="text-[9px] text-muted-foreground/60"
    />
  )
}

function getComposerPrefetchRepoId(
  state: ReturnType<typeof useAppStore.getState>,
  initialRepoId?: string
): string | null {
  const eligibleRepos = getComposerEligibleRepos(state.repos)
  return resolveComposerGitRepoId({
    eligibleRepos,
    initialRepoId,
    activeRepoId: resolveComposerActiveRepoId(state.repos, eligibleRepos, state.activeRepoId),
    focusedHostScope: state.workspaceHostScope
  })
}

function getComposerDefaultWorkspaceTarget(state: ReturnType<typeof useAppStore.getState>) {
  const eligibleRepos = getComposerEligibleRepos(state.repos)
  const activeRepoId = resolveComposerActiveRepoId(state.repos, eligibleRepos, state.activeRepoId)
  const resolution = resolveWorkspaceCreationTarget({
    eligibleRepos,
    projects: state.projects,
    projectHostSetups: state.projectHostSetups,
    activeRepoId,
    focusedHostScope: state.workspaceHostScope
  })
  return resolution.status === 'ready' ? resolution.target : null
}

function appendPaletteListEntries(
  target: PaletteListEntry[],
  source: readonly PaletteItem[]
): void {
  // Why: source can be large enough to hit the argument limit of push(...source).
  for (const entry of source) {
    target.push(entry)
  }
}

/** Multi-keyword matches highlight every covered range; ranges arrive sorted and disjoint. */
function HighlightedText({
  text,
  matchRanges
}: {
  text: string
  matchRanges: readonly MatchRange[]
}): React.JSX.Element {
  const ranges = matchRanges
  if (!ranges.length) {
    return <>{text}</>
  }
  const parts: React.ReactNode[] = []
  let cursor = 0
  for (const range of ranges) {
    const start = Math.max(cursor, range.start)
    if (start >= range.end) {
      continue
    }
    parts.push(text.slice(cursor, start))
    parts.push(
      <span key={`${range.start}-${range.end}`} className="font-semibold text-foreground">
        {text.slice(start, range.end)}
      </span>
    )
    cursor = range.end
  }
  parts.push(text.slice(cursor))
  return <>{parts}</>
}

function PaletteOpenTabPrimaryLine({
  title,
  titleRanges,
  secondaryText,
  secondaryRanges,
  sessionAge,
  leadingBadges
}: {
  title: string
  titleRanges: readonly MatchRange[]
  secondaryText: string
  secondaryRanges: readonly MatchRange[]
  sessionAge?: string
  leadingBadges?: React.ReactNode
}): React.JSX.Element {
  // Why gate on non-empty: empty secondaries (terminals/simulators) used to still
  // render a leftover "·" after the title.
  const showSecondary = secondaryText.trim().length > 0

  return (
    <div className="flex min-w-0 items-center gap-2 overflow-hidden">
      <span
        data-slot="palette-open-tab-title"
        className="min-w-0 truncate text-[14px] font-semibold tracking-[-0.01em] text-foreground"
      >
        <HighlightedText text={title} matchRanges={titleRanges} />
      </span>
      {sessionAge ? (
        <span
          aria-label={translate(
            'auto.components.WorktreeJumpPalette.lastActiveTime',
            'Last active {{value0}} ago',
            { value0: sessionAge }
          )}
          className="shrink-0 text-[11px] font-medium tabular-nums text-muted-foreground/70"
        >
          {sessionAge}
        </span>
      ) : null}
      {leadingBadges}
      {showSecondary ? (
        <>
          <span className="shrink-0 text-muted-foreground/45">·</span>
          <span className="min-w-0 max-w-[34%] truncate text-[12px] font-medium text-muted-foreground/92">
            <HighlightedText text={secondaryText} matchRanges={secondaryRanges} />
          </span>
        </>
      ) : null}
    </div>
  )
}

function resolveOpenTabWorktreeRailTooltip({
  isBranch,
  truncated,
  name
}: {
  isBranch: boolean
  truncated: boolean
  name: string
}): string {
  if (truncated) {
    return name
  }
  return isBranch
    ? translate('auto.components.WorktreeJumpPalette.paletteOpenTabBranch', 'Branch name')
    : translate('auto.components.WorktreeJumpPalette.paletteOpenTabWorkspace', 'Workspace name')
}

function PaletteOpenTabWorktreeRailLabel({
  name,
  matchRanges,
  worktree,
  className,
  slot = 'palette-open-tab-worktree'
}: {
  name: string
  matchRanges: readonly MatchRange[]
  worktree?: Pick<Worktree, 'branch'> | null
  className?: string
  slot?: string
}): React.JSX.Element | null {
  const [truncated, setTruncated] = useState(false)
  const labelRef = useRef<HTMLSpanElement | null>(null)
  // Why: observe in an effect so unmount disconnects the ResizeObserver instead of
  // leaking the callback-ref subscription (react-doctor effect-needs-cleanup).
  useLayoutEffect(() => {
    const node = labelRef.current
    if (!node) {
      setTruncated(false)
      return
    }
    const updateTruncated = (): void => {
      const next = node.scrollWidth > node.clientWidth
      setTruncated((current) => (current === next ? current : next))
    }
    updateTruncated()
    if (typeof ResizeObserver === 'undefined') {
      return
    }
    const observer = new ResizeObserver(updateTruncated)
    observer.observe(node)
    return () => observer.disconnect()
  }, [name])

  if (name.trim().length === 0) {
    return null
  }
  // Why tag the visible value: a custom display name or folder path is a workspace
  // label, not a branch, even when the workspace sits on one.
  const isBranch = worktree != null && name === resolveWorktreeBranchLabel(worktree)
  const tooltip = resolveOpenTabWorktreeRailTooltip({ isBranch, truncated, name })
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span ref={labelRef} data-slot={slot} tabIndex={-1} className={className}>
          <HighlightedText text={name} matchRanges={matchRanges} />
        </span>
      </TooltipTrigger>
      <TooltipContent side="top" sideOffset={6} className="max-w-80 break-all">
        {tooltip}
      </TooltipContent>
    </Tooltip>
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
  const visible = useAppStore((s) => s.activeModal === 'worktree-palette')
  const [lingering, setLingering] = useState(visible)
  useEffect(() => {
    if (visible) {
      setLingering(true)
      return
    }
    const timer = window.setTimeout(() => setLingering(false), PALETTE_CLOSE_LINGER_MS)
    return () => window.clearTimeout(timer)
  }, [visible])
  // Why: reopening must invalidate a pending create lookup from the previous content mount.
  const createLookupGuard = useMemo(() => createWorktreePaletteRequestGuard(), [])

  if (!visible && !lingering) {
    return null
  }
  return (
    <WorktreeJumpPaletteContent
      visible={visible}
      lingering={lingering}
      createLookupGuard={createLookupGuard}
    />
  )
}

function WorktreeJumpPaletteContent({
  visible,
  lingering,
  createLookupGuard
}: {
  visible: boolean
  lingering: boolean
  createLookupGuard: WorktreePaletteRequestGuard
}): React.JSX.Element | null {
  // Why: subscribe to language changes so translated memos recompute without a fake i18n.language dependency.
  useTranslation()
  // Why frozen on open: recomputing every keystroke would tick the session-age badges mid-session.
  // oxlint-disable-next-line react-hooks/exhaustive-deps -- visible is the freeze trigger, not a read value.
  const paletteNowMs = useMemo(() => Date.now(), [visible])
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
  const pluginCommands = usePluginCommands()
  const paletteStatusInputsActive = visible || lingering
  // Why: keep hot status maps live through the shell's close-animation linger.
  // Why: ptyIdsByTabId must be included — slept tabs keep a wake-hint sessionId in tab.ptyId, so without it the palette dot would lie green.
  const { ptyIdsByTabId, terminalLayoutsByTabId, tabsByWorktree } = useAppStore(
    useShallow((s) => selectPaletteStatusInputs(s, paletteStatusInputsActive))
  )
  const { prCache, issueCache, hostedReviewCache } = useAppStore(
    useShallow((s) => selectWorktreePaletteCacheInputs(s, paletteStatusInputsActive))
  )
  const migrationUnsupportedByPtyId = useAppStore((s) => s.migrationUnsupportedByPtyId)
  const activeView = useAppStore((s) => s.activeView)
  const activeWorktreeId = useAppStore((s) => s.activeWorktreeId)
  const activeWorkspaceExecutionHostId = useAppStore((s) => s.activeWorkspaceExecutionHostId)
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
  // Why non-reactive: agentStatusByPaneKey and runtimePaneTitlesByTabId are the two hottest maps in
  // the app, and subscribing re-rendered the whole palette on every agent transition to change
  // nothing but the status dots — which now hold their own subscription (PaletteLiveStatusProvider).
  // Reading them here snapshots them for indexing, ordering and filtering instead, refreshed when
  // the palette opens or the tab set changes: the same freeze-on-open the row order already gets.
  const paletteIndexStatus = useMemo(
    () => selectPaletteIndexStatusSnapshot(useAppStore.getState(), paletteStatusInputsActive),
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- these deps ARE the refresh policy, not reads: re-snapshot when the palette opens or the tab set moves under it, never on the agent churn the snapshot exists to ignore.
    [paletteStatusInputsActive, tabsByWorktree, unifiedTabsByWorktree]
  )
  // Why the unread maps ride the same snapshot: recent-section membership is decided once, with the
  // same open-time reading the frozen row order uses. Subscribing here would re-render the whole
  // palette on app-wide unread churn to change membership the frozen order can no longer honour.
  const {
    agentStatusByPaneKey,
    runtimePaneTitlesByTabId,
    unreadTerminalTabs,
    unreadAgentCompletionPanes
  } = paletteIndexStatus
  const openFiles = useAppStore((s) => s.openFiles)
  const activeGroupIdByWorktree = useAppStore((s) => s.activeGroupIdByWorktree)
  const groupsByWorktree = useAppStore((s) => s.groupsByWorktree)
  const retainedAgentsByPaneKey = useAppStore((s) => s.retainedAgentsByPaneKey)
  const sleepingAgentSessionsByPaneKey = useAppStore((s) => s.sleepingAgentSessionsByPaneKey)
  const paneForegroundAgentByPaneKey = useAppStore((s) => s.paneForegroundAgentByPaneKey)
  const settings = useAppStore((s) => s.settings)
  const worktreeVisibilityDefaultsByHost = useAppStore((s) => s.worktreeVisibilityDefaultsByHost)
  const sshTargetLabels = useAppStore((s) => s.sshTargetLabels)
  const sshConnectionStates = useAppStore((s) => s.sshConnectionStates)
  const runtimeEnvironments = useAppStore((s) => s.runtimeEnvironments)
  const runtimeStatusByEnvironmentId = useAppStore((s) => s.runtimeStatusByEnvironmentId)
  const hideDefaultBranchWorkspace = useAppStore((s) => s.hideDefaultBranchWorkspace)
  const hideAutomationGeneratedWorkspaces = useAppStore((s) => s.hideAutomationGeneratedWorkspaces)
  const hideCliCreatedWorkspaces = useAppStore((s) => s.hideCliCreatedWorkspaces)
  const hideDetachedHeadWorkspaces = useAppStore((s) => s.hideDetachedHeadWorkspaces)
  const hideWorkspacesFromOtherDevices = useAppStore((s) => s.hideWorkspacesFromOtherDevices)
  const showSleepingWorkspaces = useAppStore((s) => s.showSleepingWorkspaces)
  const alwaysShowDefaultBranchWorkspace = useAppStore((s) => s.alwaysShowDefaultBranchWorkspace)
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
  const liveQueryRef = useRef(query)
  liveQueryRef.current = query
  // Why a ref: creation must follow an explicit ArrowDown/click, and typing re-arms
  // the guard without re-rendering the list.
  const selectionMovedByUserRef = useRef(false)
  const taskSourceUrl = useMemo(() => parseCmdJTaskSourceUrl(query), [query])
  const linearIssueUrlIntent = taskSourceUrl?.provider === 'linear' ? taskSourceUrl.intent : null
  const githubUrlLink = taskSourceUrl?.provider === 'github' ? taskSourceUrl.link : null
  const parsedTaskUrlCreatePreview = useMemo(
    () => (taskSourceUrl ? getCmdJTaskUrlCreatePreview(taskSourceUrl) : null),
    [taskSourceUrl]
  )
  const [selectedItemId, setSelectedItemId] = useState('')
  const [linearIssuePreview, setLinearIssuePreview] = useState<CmdJLinearIssuePreview | null>(null)
  const [githubWorkItemPreview, setGithubWorkItemPreview] =
    useState<CmdJGitHubWorkItemPreview | null>(null)
  const githubLookupGenerationRef = useRef(0)
  const githubLookupRef = useRef<{
    query: string
    promise: Promise<CmdJGitHubWorkItemPreview>
  } | null>(null)
  const linearIssueLookupGenerationRef = useRef(0)
  const linearIssueLookupRef = useRef<{
    query: string
    promise: Promise<CmdJLinearIssuePreview>
  } | null>(null)
  // Why: the id cmdk auto-selected for the last committed list, so a late recent-order snapshot can
  // tell "nobody has moved the highlight yet" from "the user arrowed somewhere deliberately".
  const autoSelectedItemIdRef = useRef<string | null>(null)
  const digitShortcutItemsRef = useRef<readonly PaletteItem[]>([])
  // Why: filters reset on close — a filter that survives reopen silently hides
  // results in a surface people open reflexively.
  const [rawFilter, setRawFilter] = useState<PaletteFilterState>(EMPTY_PALETTE_FILTER)
  const [prevQuery, setPrevQuery] = useState(query)
  const [prevVisible, setPrevVisible] = useState(visible)
  const [expandedSectionCaps, setExpandedSectionCaps] = useState<Record<string, number>>({})

  if (prevQuery !== query || prevVisible !== visible) {
    setPrevQuery(query)
    setPrevVisible(visible)
    setExpandedSectionCaps({})
  }

  const handleExpandSection = useCallback((sectionKey: string) => {
    setExpandedSectionCaps((prev) => ({
      ...prev,
      [sectionKey]: (prev[sectionKey] ?? 0) + PALETTE_SECTION_EXPAND_STEP
    }))
  }, [])

  const [dialogElement, setDialogElement] = useState<HTMLElement | null>(null)
  const previousWorktreeIdRef = useRef<string | null>(null)
  const previousActiveTabTypeRef = useRef<WorkspaceVisibleTabType>('terminal')
  const previousBrowserPageIdRef = useRef<string | null>(null)
  const previousBrowserFocusTargetRef = useRef<'webview' | 'address-bar'>('webview')
  // Why: the exact element focused before Cmd+J opened, so Escape restores it precisely (not a background worktree's hidden terminal).
  const previousFocusElementRef = useRef<HTMLElement | null>(null)
  const activeGroupSnapshotRef = useRef<CmdJActiveGroupSnapshot | null>(null)
  const wasVisibleRef = useRef(false)
  const skipRestoreFocusRef = useRef(false)
  const listRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const fallbackFocusOuterFrameRef = useRef<number | null>(null)
  const fallbackFocusInnerFrameRef = useRef<number | null>(null)
  const preserveCreateLookupOnCloseRef = useRef(false)

  const repoMap = useMemo(() => new Map(repos.map((r) => [r.id, r])), [repos])
  const repoByHostIdentity = useMemo(
    () => new Map(repos.map((repo) => [getRepoHostIdentity(repo), repo])),
    [repos]
  )
  // Why one resolver: a runtime-owned SSH row must not bypass fail-closed ownership through its physical host.
  const resolveRepoForWorktree = useCallback(
    (
      worktree: Pick<Worktree, 'id' | 'repoId' | 'hostId' | 'runtimeOwnerEnvironmentId'>
    ): Repo | undefined => resolvePaletteRepoForWorktree(worktree, repoMap, repoByHostIdentity),
    [repoByHostIdentity, repoMap]
  )

  const hostLabelOverrides = useMemo(() => getHostDisplayLabelOverrides(settings), [settings])
  // Why: reuse the sidebar host-scope registry so host badge labels stay in sync.
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

  // Why: host-less repos and worktrees inherit the focused runtime host, exactly
  // as the sidebar's host headers do — otherwise the two disagree on bucketing.
  const defaultHostId = useMemo(() => getSettingsFocusedExecutionHostId(settings), [settings])
  const filterModel = useMemo(
    () =>
      buildPaletteFilterModel({
        repos,
        worktrees: allWorktrees,
        hostOptions,
        projects,
        projectHostSetups,
        defaultHostId
      }),
    [allWorktrees, defaultHostId, hostOptions, projectHostSetups, projects, repos]
  )
  // Why: a selection whose repo or SSH target disappeared would otherwise keep
  // the palette permanently empty with nothing on screen explaining it. Memoized
  // because a prune allocates, and an unstable identity here would invalidate
  // every downstream search memo on every render.
  const filter = useMemo(
    () => reconcilePaletteFilter(rawFilter, filterModel),
    [rawFilter, filterModel]
  )
  // Why persist the prune: otherwise a dropped id lives on in rawFilter and
  // silently re-activates — with no chip on screen — if its host or project
  // comes back. Same-reference return on a no-op keeps this from re-rendering.
  useEffect(() => {
    setRawFilter((current) => reconcilePaletteFilter(current, filterModel))
  }, [filterModel])
  const filterActive = isPaletteFilterActive(filter)
  const hostFilterActive = filter.hostIds.length > 0
  const filterPredicate = useMemo(
    () => buildPaletteFilterPredicate(filter, filterModel),
    [filter, filterModel]
  )
  // Why: same resolver the sidebar's host filtering uses, so a group row lands on
  // the host its header claims — including the host-less "inherit default" case.
  const groupHostIdByGroupId = useMemo(
    () =>
      new Map(
        projectGroups.map((group) => [
          group.id,
          getProjectGroupExecutionHostIdForRows(group, defaultHostId)
        ])
      ),
    [defaultHostId, projectGroups]
  )

  const paletteSearchQuery = taskSourceUrl ? query.trim() : deferredQuery.trim()
  const hasQuery = paletteSearchQuery.length > 0
  const isLoading = repos.length > 0 && Object.keys(worktreesByRepo).length === 0

  // Why: keep running-agent workspaces visible under "Hide sleeping" even when the live PTY is momentarily absent, matching sidebar. #7197
  // Why snapshot-scoped: this decides which rows exist, and rows appearing or vanishing mid-open
  // would shift the list under the cursor — the same reason the recent order freezes on open.
  const worktreeIdsWithLiveAgent = useMemo(
    () =>
      new Set(
        getLiveAgentStatusByWorktreeId(agentStatusByPaneKey, tabsByWorktree, Date.now()).keys()
      ),
    [agentStatusByPaneKey, tabsByWorktree]
  )
  const pairedDeviceIdsByEnvironment = useMemo(
    () =>
      hideWorkspacesFromOtherDevices
        ? getPairedDeviceIdsByEnvironment(runtimeEnvironments, runtimeStatusByEnvironmentId)
        : EMPTY_PAIRED_DEVICE_IDS_BY_ENVIRONMENT,
    [hideWorkspacesFromOtherDevices, runtimeEnvironments, runtimeStatusByEnvironmentId]
  )

  // Why: empty-query mirrors sidebar filters so Search opens on the same quiet list; typed search widens to global non-archived scope.
  const emptyQueryVisibleWorktrees = useMemo(
    () =>
      allWorktrees.filter((worktree) => {
        if (worktree.isArchived) {
          return false
        }
        // Why: filtering here (not after search) keeps the whole pipeline —
        // smart-sort, search, tab indexing — working on the narrowed set.
        if (filterPredicate && !filterPredicate.matchesWorktree(worktree)) {
          return false
        }
        if (hideDefaultBranchWorkspace && isDefaultBranchWorkspace(worktree)) {
          return false
        }
        if (hideAutomationGeneratedWorkspaces && isAutomationGeneratedWorkspace(worktree)) {
          return false
        }
        if (hideCliCreatedWorkspaces && isCliCreatedWorkspace(worktree)) {
          return false
        }
        if (hideDetachedHeadWorkspaces && isDetachedHeadWorkspace(worktree)) {
          return false
        }
        if (
          hideWorkspacesFromOtherDevices &&
          isWorkspaceFromOtherDevice(worktree, pairedDeviceIdsByEnvironment)
        ) {
          return false
        }
        if (
          !showSleepingWorkspaces &&
          // Why the exemption here too: Cmd+J re-implements the sidebar's
          // filter pass, so the shared predicate is what keeps them in step.
          !isSleepingSweepExemptWorkspace(worktree, alwaysShowDefaultBranchWorkspace) &&
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
      alwaysShowDefaultBranchWorkspace,
      browserTabsByWorktree,
      filterPredicate,
      hideAutomationGeneratedWorkspaces,
      hideCliCreatedWorkspaces,
      hideDefaultBranchWorkspace,
      hideDetachedHeadWorkspaces,
      hideWorkspacesFromOtherDevices,
      pairedDeviceIdsByEnvironment,
      ptyIdsByTabId,
      showSleepingWorkspaces,
      tabsByWorktree,
      worktreeIdsWithLiveAgent
    ]
  )

  // Why: empty-query rows order by focus-recency (quiet/SSH worktrees stay visible) and exclude the current worktree, kept only in visibleWorktreesForState. See docs/cmd-j-empty-query-ordering.md.
  const { visibleWorktreesForState, switchableWorktreesForRows } = useMemo(
    () =>
      orderEmptyQueryWorktrees({
        visibleWorktrees: emptyQueryVisibleWorktrees,
        activeWorktreeId,
        activeWorkspaceExecutionHostId,
        lastVisitedAtByWorktreeId
      }),
    [
      emptyQueryVisibleWorktrees,
      activeWorktreeId,
      activeWorkspaceExecutionHostId,
      lastVisitedAtByWorktreeId
    ]
  )

  const searchScopeWorktrees = useMemo(() => {
    const scope = getWorktreePaletteSearchScope({
      hasQuery,
      allWorktrees,
      emptyQueryWorktrees: switchableWorktreesForRows
    })
    // Why: the typed-query branch widens back to allWorktrees, so the filter has
    // to be re-applied there; the empty-query branch is already narrowed.
    return hasQuery && filterPredicate ? scope.filter(filterPredicate.matchesWorktree) : scope
  }, [allWorktrees, filterPredicate, hasQuery, switchableWorktreesForRows])

  // Why: browser-tab search is cross-worktree, so sort all worktrees once (including archived).
  // Gated on paletteStatusInputsActive so the closed-but-mounted palette skips the sort entirely.
  const browserSortedWorktrees = useMemo(() => {
    if (!paletteStatusInputsActive) {
      return EMPTY_SORTED_WORKTREES
    }
    const scope = filterPredicate
      ? allWorktrees.filter(filterPredicate.matchesWorktree)
      : allWorktrees
    return sortWorktreesSmart(
      scope,
      tabsByWorktree,
      repoMap,
      agentStatusByPaneKey,
      runtimePaneTitlesByTabId,
      ptyIdsByTabId,
      migrationUnsupportedByPtyId,
      terminalLayoutsByTabId
    )
  }, [
    paletteStatusInputsActive,
    allWorktrees,
    filterPredicate,
    tabsByWorktree,
    repoMap,
    agentStatusByPaneKey,
    runtimePaneTitlesByTabId,
    ptyIdsByTabId,
    migrationUnsupportedByPtyId,
    terminalLayoutsByTabId
  ])

  // Why: derive typed-query sort from browserSortedWorktrees (P2-a) — both call sortWorktreesSmart
  // with the same deps, so filtering the superset avoids a redundant sort.
  const sortedWorktrees = useMemo(
    () => (hasQuery ? browserSortedWorktrees.filter((w) => !w.isArchived) : searchScopeWorktrees),
    [hasQuery, browserSortedWorktrees, searchScopeWorktrees]
  )

  // Why browser search includes archived worktrees, so its host-qualified metadata index must too.
  const paletteWorktreeIndex = useMemo(
    () => buildPaletteWorktreeIndex(browserSortedWorktrees),
    [browserSortedWorktrees]
  )

  const resolveWorktree = useCallback(
    (worktreeId: string, hostId: ExecutionHostId | undefined): Worktree | undefined =>
      resolvePaletteWorktree(paletteWorktreeIndex, worktreeId, hostId),
    [paletteWorktreeIndex]
  )

  const worktreeOrder = useMemo(
    () =>
      new Map(
        browserSortedWorktrees.map((worktree, index) => [getWorktreeHostIdentity(worktree), index])
      ),
    [browserSortedWorktrees]
  )

  const checksReviewByWorktree = useMemo(
    () =>
      buildWorktreeChecksReviewIndex({
        worktrees: allWorktrees,
        repoByHostIdentity,
        prCache,
        hostedReviewCache,
        settings
      }),
    [allWorktrees, hostedReviewCache, prCache, repoByHostIdentity, settings]
  )

  // Why only rendered labels: a host match the row never prints would be unexplainable.
  const hostLabelByWorktreeId = useMemo(() => {
    const labels = new Map<string, string>()
    for (const worktree of allWorktrees) {
      const badge = getPaletteHostBadge(
        resolveRepoForWorktree(worktree),
        hostOptions,
        hostFilterActive
      )
      if (badge) {
        labels.set(getWorktreeHostIdentity(worktree), badge.label)
      }
    }
    return labels
  }, [allWorktrees, hostFilterActive, hostOptions, resolveRepoForWorktree])

  // Why keyed on the unsorted list: normalized documents depend only on text
  // inputs, so re-sorting for recency re-ranks without re-normalizing anything.
  const worktreeDocuments = useMemo(
    () =>
      // Archived workspaces are never searchable, so normalizing them is waste.
      buildWorktreePaletteDocuments(
        allWorktrees.filter((worktree) => !worktree.isArchived),
        {
          repoMap,
          repoMapByHostIdentity: repoByHostIdentity,
          prCache,
          issueCache,
          workspacePortsByWorktreeId: getWorkspacePortsByWorktreeId(workspacePortScan),
          checksReviewByWorktree,
          hostLabelByWorktreeId
        }
      ),
    [
      allWorktrees,
      repoByHostIdentity,
      repoMap,
      prCache,
      issueCache,
      workspacePortScan,
      checksReviewByWorktree,
      hostLabelByWorktreeId
    ]
  )

  const worktreeMatches = useMemo(
    () =>
      searchWorktreeDocuments({
        worktrees: sortedWorktrees,
        query: paletteSearchQuery,
        documents: worktreeDocuments,
        repoMap,
        repoMapByHostIdentity: repoByHostIdentity,
        checksReviewByWorktree
      }),
    [
      sortedWorktrees,
      paletteSearchQuery,
      worktreeDocuments,
      repoByHostIdentity,
      repoMap,
      checksReviewByWorktree
    ]
  )

  const browserPageEntries = useMemo<SearchableBrowserPage[]>(() => {
    if (!paletteStatusInputsActive) {
      return EMPTY_BROWSER_PAGE_ENTRIES
    }
    return buildSearchableBrowserPages({
      worktrees: browserSortedWorktrees,
      ownershipWorktrees: allWorktrees,
      repoMap,
      repoMapByHostIdentity: repoByHostIdentity,
      worktreeOrder,
      browserTabsByWorktree,
      browserPagesByWorkspace,
      unifiedTabsByWorktree,
      activeBrowserTabId,
      activeWorktreeId,
      activeWorkspaceExecutionHostId,
      activeTabType
    })
  }, [
    paletteStatusInputsActive,
    activeBrowserTabId,
    activeTabType,
    activeWorktreeId,
    activeWorkspaceExecutionHostId,
    allWorktrees,
    browserPagesByWorkspace,
    browserTabsByWorktree,
    browserSortedWorktrees,
    repoByHostIdentity,
    repoMap,
    unifiedTabsByWorktree,
    worktreeOrder
  ])

  const browserMatches = useMemo(
    () => searchBrowserPages(browserPageEntries, deferredQuery.trim()),
    [browserPageEntries, deferredQuery]
  )

  const simulatorTabEntries = useMemo<SearchableSimulatorTab[]>(() => {
    if (!paletteStatusInputsActive) {
      return EMPTY_SIMULATOR_TAB_ENTRIES
    }
    return buildSearchableSimulatorTabs({
      worktrees: browserSortedWorktrees,
      ownershipWorktrees: allWorktrees,
      repoMap,
      repoMapByHostIdentity: repoByHostIdentity,
      worktreeOrder,
      unifiedTabsByWorktree,
      activeGroupIdByWorktree,
      groupsByWorktree,
      activeWorktreeId,
      activeWorkspaceExecutionHostId,
      activeTabType
    })
  }, [
    paletteStatusInputsActive,
    activeGroupIdByWorktree,
    activeTabType,
    activeWorktreeId,
    activeWorkspaceExecutionHostId,
    allWorktrees,
    browserSortedWorktrees,
    groupsByWorktree,
    repoMap,
    repoByHostIdentity,
    unifiedTabsByWorktree,
    worktreeOrder
  ])

  const simulatorMatches = useMemo(
    () => searchSimulatorTabs(simulatorTabEntries, deferredQuery.trim()),
    [simulatorTabEntries, deferredQuery]
  )

  const workspaceTabEntries = useMemo<SearchableWorkspaceTab[]>(() => {
    if (!paletteStatusInputsActive) {
      return EMPTY_WORKSPACE_TAB_ENTRIES
    }
    return buildSearchableWorkspaceTabs({
      worktrees: browserSortedWorktrees,
      ownershipWorktrees: allWorktrees,
      repoMap,
      repoMapByHostIdentity: repoByHostIdentity,
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
      activeWorkspaceExecutionHostId,
      activeTabType,
      activeTabId,
      activeTabIdByWorktree,
      activeFileId,
      activeFileIdByWorktree,
      activeTabTypeByWorktree,
      generatedTitlesEnabled: settings?.tabAutoGenerateTitle === true,
      terminalLayoutsByTabId,
      paneForegroundAgentByPaneKey
    })
  }, [
    paletteStatusInputsActive,
    activeFileId,
    activeFileIdByWorktree,
    activeGroupIdByWorktree,
    activeTabId,
    activeTabIdByWorktree,
    activeTabType,
    activeTabTypeByWorktree,
    activeWorktreeId,
    activeWorkspaceExecutionHostId,
    agentStatusByPaneKey,
    allWorktrees,
    browserSortedWorktrees,
    groupsByWorktree,
    openFiles,
    repoByHostIdentity,
    repoMap,
    retainedAgentsByPaneKey,
    settings?.tabAutoGenerateTitle,
    sleepingAgentSessionsByPaneKey,
    paneForegroundAgentByPaneKey,
    tabsByWorktree,
    terminalLayoutsByTabId,
    unifiedTabsByWorktree,
    worktreeOrder
  ])

  const workspaceTabMatches = useMemo(
    () => searchWorkspaceTabs(workspaceTabEntries, deferredQuery.trim()),
    [workspaceTabEntries, deferredQuery]
  )

  const worktreeItems = useMemo<WorktreePaletteItem[]>(() => {
    const items = worktreeMatches
      .map((match) => {
        const worktree = resolveWorktree(match.worktreeId, match.worktreeHostId)
        if (!worktree) {
          return null
        }
        return {
          // Why the bare id stays: buildPaletteListEntryRenderKeys already disambiguates a
          // repeated id for React and cmdk, and the row now resolves through its own host
          // above — so the visible command value needs no host suffix.
          id: `worktree:${worktree.id}`,
          type: 'worktree' as const,
          match,
          worktree
        }
      })
      .filter((item): item is WorktreePaletteItem => item !== null)
    if (!hasQuery) {
      return items
    }
    // Why re-sort: searchWorktreeDocuments preserves smart-sort order, so a weaker
    // match used to outrank a stronger one. Smart order stays the tiebreaker.
    const orderById = new Map(items.map((item, index) => [item.id, index]))
    return items.sort((a, b) =>
      comparePaletteRankedItems(
        { rank: a.match.rank, order: orderById.get(a.id) ?? 0, id: a.id },
        { rank: b.match.rank, order: orderById.get(b.id) ?? 0, id: b.id }
      )
    )
  }, [hasQuery, resolveWorktree, worktreeMatches])

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

  const openTabItems = useMemo<OpenTabPaletteItem[]>(() => {
    const items = [...browserItems, ...simulatorItems, ...workspaceTabItems]
    // Why match rank first: each source's score folds in worktree/tab position, so a
    // prefix hit in a far worktree used to sink below a mid-title hit in the current one.
    // An empty query leaves every rank null, so ordering falls through to those scores.
    return items.sort((a, b) =>
      comparePaletteRankedItems(
        {
          rank: a.result.rank,
          order: a.result.score,
          id: a.id,
          lastActiveAt: a.result.lastActiveAt ?? undefined
        },
        {
          rank: b.result.rank,
          order: b.result.score,
          id: b.id,
          lastActiveAt: b.result.lastActiveAt ?? undefined
        }
      )
    )
  }, [browserItems, simulatorItems, workspaceTabItems])

  const terminalTabsById = useMemo(() => {
    const byId = new Map<string, TerminalTab>()
    for (const tabs of Object.values(tabsByWorktree)) {
      for (const tab of tabs ?? []) {
        byId.set(tab.id, tab)
      }
    }
    return byId
  }, [tabsByWorktree])

  const recentTabPaneSources = useMemo<TabPaneInputSources>(
    () => ({
      entriesByTabId: buildExplicitEntriesByTabId(
        agentStatusByPaneKey,
        migrationUnsupportedByPtyId
      ),
      ptyIdsByTabId,
      runtimePaneTitlesByTabId,
      terminalLayoutsByTabId
    }),
    [
      agentStatusByPaneKey,
      migrationUnsupportedByPtyId,
      ptyIdsByTabId,
      runtimePaneTitlesByTabId,
      terminalLayoutsByTabId
    ]
  )

  // Why unfiltered: a row already frozen into the recent order must keep resolving its badge even
  // once inclusion would drop it (a current tab that quiets down), or the pip blanks mid-open.
  const openTabRecentRows = useMemo<OpenTabRecentRow[]>(() => {
    const entries: OpenTabRecentRow[] = []
    const occurrenceIds = buildRecentTabOccurrenceIds(openTabItems)
    for (const [index, item] of openTabItems.entries()) {
      const worktree = resolveWorktree(item.result.worktreeId, item.result.executionHostId)
      if (!worktree) {
        continue
      }
      const occurrenceId = occurrenceIds[index]
      entries.push({
        item,
        occurrenceId,
        worktree,
        row: {
          id: item.id,
          occurrenceId,
          worktreeId: worktree.id,
          worktreeHostId: worktree.hostId,
          unifiedTabId: item.type === 'browser-page' ? null : item.result.tabId,
          terminalTab:
            item.type === 'workspace-tab' && item.result.contentType === 'terminal'
              ? (terminalTabsById.get(item.result.entityId) ?? null)
              : null,
          worktreeLastActivityAt: worktree.lastActivityAt
        }
      })
    }
    return entries
  }, [openTabItems, resolveWorktree, terminalTabsById])

  const recentTabRowByItem = useMemo(
    () => new Map(openTabRecentRows.map(({ item, row }) => [item, row])),
    [openTabRecentRows]
  )

  // Why: empty-query recent skips idle current tabs ("you're already there") and archived
  // worktrees; high-signal current agents still surface so working / ask-question / unread
  // badges stay visible. Typed-query still indexes every open tab.
  const recentTabRows = useMemo<RecentWorkspaceTabRow[]>(() => {
    const now = Date.now()
    const rows: RecentWorkspaceTabRow[] = []
    for (const { item, worktree, row } of openTabRecentRows) {
      if (
        shouldIncludeOpenTabInRecentSection({
          item,
          worktree,
          row,
          paneSources: recentTabPaneSources,
          unreadTerminalTabs,
          unreadAgentCompletionPanes,
          now
        })
      ) {
        rows.push(row)
      }
    }
    return rows
  }, [openTabRecentRows, recentTabPaneSources, unreadAgentCompletionPanes, unreadTerminalTabs])

  // Why: ordering is captured once on open. Live re-ranking would move rows under the cursor and
  // send ⌘3 to the wrong row; dots keep updating, positions don't.
  const [recentTabOrder, setRecentTabOrder] = useState<readonly string[]>(EMPTY_RECENT_TAB_ORDER)
  const recentTabOrderCapturedRef = useRef(false)
  // Why: unified tabs can land before tabsByWorktree entities. A capture then ranks every chat as
  // IDLE; allow one re-capture when entities arrive, then freeze for good.
  const recentTabOrderAttentionReadyRef = useRef(false)
  // Terminal rows without a tabsByWorktree entity can't resolve attention yet (see orderRecent…).
  // Why current tabs count too: the missing entity is also what decides whether a current tab has a
  // badge worth listing, so a capture now would freeze it out for the whole open. Archived is the
  // one exclusion that needs no entity.
  const recentOrderAttentionIncomplete = useMemo(() => {
    for (const { item, worktree, row } of openTabRecentRows) {
      if (
        item.type !== 'workspace-tab' ||
        item.result.contentType !== 'terminal' ||
        row.terminalTab ||
        worktree.isArchived
      ) {
        continue
      }
      return true
    }
    return false
  }, [openTabRecentRows])
  // Why layout, not passive: a post-paint capture shows one frame of worktrees-only, which flashes
  // the list, renumbers ⌘1–6 under the user, and lets cmdk latch a worktree as the Enter target.
  useLayoutEffect(() => {
    if (!visible) {
      recentTabOrderCapturedRef.current = false
      recentTabOrderAttentionReadyRef.current = false
      autoSelectedItemIdRef.current = null
      setRecentTabOrder(EMPTY_RECENT_TAB_ORDER)
      return
    }
    // Why: the query and filter are cleared by the open effect below, which runs after this one —
    // capturing before that lands would freeze the *previous* session's filtered subset for good.
    if (hasQuery || query.length > 0 || filterActive) {
      return
    }
    // Fully frozen after an attention-ready capture; provisional freeze while entities still pending
    // so agent-status churn can't reshuffle under the cursor before the one-shot re-rank.
    if (recentTabOrderCapturedRef.current) {
      if (recentTabOrderAttentionReadyRef.current || recentOrderAttentionIncomplete) {
        return
      }
      // Incomplete → complete: fall through and re-capture with real attention ranks.
    }
    const order = orderRecentWorkspaceTabs({
      rows: recentTabRows,
      paneSources: recentTabPaneSources,
      now: Date.now(),
      lastVisitedAtByWorktreeId,
      focusedGroupTabRecency: buildFocusedGroupTabRecency(activeGroupIdByWorktree, groupsByWorktree)
    })
    if (order.length === 0) {
      // Why: tabs can arrive after the palette opens (cold start, session restore, a late tab
      // mirror). Latching an empty snapshot would leave Recent dead — and digits inert — until
      // close+reopen. Also clear a provisional latch: incomplete→complete fallthrough can hit empty
      // if open tabs briefly vanish, and keeping captured would freeze an empty Recent forever.
      recentTabOrderCapturedRef.current = false
      recentTabOrderAttentionReadyRef.current = false
      setRecentTabOrder(EMPTY_RECENT_TAB_ORDER)
      return
    }
    recentTabOrderCapturedRef.current = true
    recentTabOrderAttentionReadyRef.current = !recentOrderAttentionIncomplete
    setRecentTabOrder(order)
    // Why: recents render above the worktrees, so a row auto-selected before they arrived is no
    // longer the list head — hand Enter back to the top, matching ⌘1. Untouched selections only:
    // a highlight the user moved themselves stays put.
    setSelectedItemId((current) =>
      current === '' || current === autoSelectedItemIdRef.current ? '' : current
    )
  }, [
    activeGroupIdByWorktree,
    filterActive,
    groupsByWorktree,
    hasQuery,
    lastVisitedAtByWorktreeId,
    query.length,
    recentOrderAttentionIncomplete,
    recentTabPaneSources,
    recentTabRows,
    visible
  ])

  // Why walk the frozen order, and cap after resolving: agent churn must not reshuffle rows, and a
  // mid-open chip narrows `openTabItems` — capping first would leave the section empty.
  const recentTabItems = useMemo<PaletteItem[]>(() => {
    const itemByOccurrenceId = new Map(
      openTabRecentRows.map(({ occurrenceId, item }) => [occurrenceId, item])
    )
    return recentTabOrder
      .flatMap((occurrenceId) => itemByOccurrenceId.get(occurrenceId) ?? [])
      .slice(0, EMPTY_QUERY_RECENT_TAB_CAP)
  }, [openTabRecentRows, recentTabOrder])

  const settingsResults = useMemo(
    () => buildCmdJSettingsResults(settingsSections),
    [settingsSections]
  )
  const actionResults = useMemo(
    () =>
      buildCmdJActionResults([
        ...getCmdJQuickActions(),
        ...buildPluginQuickActions(pluginCommands)
      ]),
    [pluginCommands]
  )
  // Why: only offer project jumps the sidebar can reveal — archived-only repos are excluded from navigation.
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
      detectedWorktreesByRepo,
      settings,
      visibilityDefaultsByHost: worktreeVisibilityDefaultsByHost
    }).keys()) {
      ids.add(repoId)
    }
    for (const creation of Object.values(pendingWorktreeCreations)) {
      ids.add(creation.request.repoId)
    }
    return ids
  }, [
    allWorktrees,
    detectedWorktreesByRepo,
    pendingWorktreeCreations,
    repos,
    settings,
    worktreeVisibilityDefaultsByHost,
    worktreesByRepo
  ])
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
          })
            .filter((result) => {
              if (!filterPredicate) {
                return true
              }
              return result.kind === 'project'
                ? filterPredicate.matchesProjectRowKey(result.rowKey)
                : filterPredicate.matchesGroupHostId(
                    groupHostIdByGroupId.get(result.id.slice('project-group:'.length)) ??
                      defaultHostId
                  )
            })
            .map((result) => ({
              id: result.id,
              type: 'project-target' as const,
              result
            }))
        : [],
    [
      deferredQuery,
      defaultHostId,
      filterPredicate,
      groupHostIdByGroupId,
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
    const { activeView, activeWorktreeId, activeWorkspaceExecutionHostId } = useAppStore.getState()
    if (activeView !== 'terminal' || !activeWorktreeId) {
      return
    }
    // Why: let the palette close before mounting the delete-confirm modal so Radix focus teardown can't fight it.
    // Why (STA-4343): name the active workspace's host, or a colliding id deletes whichever row wins first-wins.
    queueMicrotask(() =>
      runWorktreeDelete(
        activeWorktreeId,
        activeWorkspaceExecutionHostId ? { expectedHostId: activeWorkspaceExecutionHostId } : {}
      )
    )
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

  // Why: filtering via buildQuickActionContext() inside a memo with stable primitive deps
  // instead of calling it inline every render — a fresh context object as a useMemo dep
  // defeated the middleItems memo (new identity every keystroke).
  const quickActionAvailabilityInputs = useMemo(
    () => ({
      activeView,
      activeWorktreeId,
      worktreesByRepo,
      repos,
      sshConnectionStates,
      activeGroupIdByWorktree,
      groupsByWorktree,
      isLoading,
      activeRuntimeEnvironmentId: settings?.activeRuntimeEnvironmentId,
      runtimeStatusByEnvironmentId
    }),
    [
      activeView,
      activeWorktreeId,
      worktreesByRepo,
      repos,
      sshConnectionStates,
      activeGroupIdByWorktree,
      groupsByWorktree,
      isLoading,
      settings?.activeRuntimeEnvironmentId,
      runtimeStatusByEnvironmentId
    ]
  )
  const availableActionResults = useMemo(() => {
    void quickActionAvailabilityInputs
    const ctx = buildQuickActionContext()
    return actionResults.filter((action) => action.isAvailable(ctx).available)
  }, [actionResults, buildQuickActionContext, quickActionAvailabilityInputs])

  const middleItems = useMemo<(SettingsPaletteItem | QuickActionPaletteItem)[]>(
    () =>
      rankCmdJMiddleResults({
        query: deferredQuery,
        settingsResults,
        actionResults: availableActionResults
      }).map((result) =>
        result.kind === 'settings'
          ? { id: result.id, type: 'settings' as const, result }
          : { id: `quick-action:${result.id}`, type: 'quick-action' as const, result }
      ),
    [availableActionResults, deferredQuery, settingsResults]
  )

  // Why: a settings, action, or project hit whose query exactly matches its intent is
  // decisive, so it may lead entity sections that only matched partially.
  const middleLeadsSections = useMemo(() => {
    if (!hasQuery) {
      return false
    }
    const entityRank = Math.min(
      worktreeItems[0]
        ? bestPaletteQualityRank([worktreeItems[0].match.qualityClass])
        : NO_PALETTE_QUALITY_RANK,
      openTabItems[0]
        ? bestPaletteQualityRank([openTabItems[0].result.qualityClass])
        : NO_PALETTE_QUALITY_RANK
    )
    return shouldIntentSectionLeadPaletteSections({
      bestEntityQualityRank: entityRank,
      bestIntentQualityRank: bestPaletteQualityRank([
        bestCmdJPaletteSectionQualityClass(middleItems.map((item) => item.result)),
        bestCmdJPaletteSectionQualityClass(projectTargetItems.map((item) => item.result))
      ])
    })
  }, [hasQuery, middleItems, openTabItems, projectTargetItems, worktreeItems])

  // Why: both lists are relevance-sorted, so their heads carry each section's best hit. The stronger
  // one leads; ties go to open tabs, matching the empty-query view and favouring a tab already open
  // over a workspace the user would have to switch to.
  const openTabsLeadSections = useMemo(() => {
    if (!hasQuery) {
      return true
    }
    // Why the shared class: section scores encode their own list position, so only
    // a common quality vocabulary can say which section holds the better hit.
    return shouldOpenTabsLeadPaletteSections({
      bestWorktreeQualityRank: worktreeItems[0]
        ? bestPaletteQualityRank([worktreeItems[0].match.qualityClass])
        : NO_PALETTE_QUALITY_RANK,
      bestOpenTabQualityRank: openTabItems[0]
        ? bestPaletteQualityRank([openTabItems[0].result.qualityClass])
        : NO_PALETTE_QUALITY_RANK
    })
  }, [hasQuery, openTabItems, worktreeItems])

  const paletteSections = useMemo(() => {
    const openTabsCap = PALETTE_SECTION_RENDER_CAP + (expandedSectionCaps['open-tabs'] ?? 0)
    const openTabs = hasQuery
      ? capPaletteSection(openTabItems, openTabsCap)
      : { visible: recentTabItems, overflowCount: 0 }
    // Why: the worktree section shrinks against the recent rows to hold the empty-query list at its
    // pre-existing 10, so RECENT WORKTREES stays above the fold. An empty recent section hands the
    // whole budget to worktrees but never uncaps — a filter chip or a tab-less session used to drop
    // every open tab and mount one row per workspace.
    const baseWorktreeCap = hasQuery
      ? Infinity
      : Math.min(
          openTabs.visible.length === 0 ? EMPTY_QUERY_ROW_BUDGET : EMPTY_QUERY_WORKTREE_CAP,
          Math.max(1, EMPTY_QUERY_ROW_BUDGET - openTabs.visible.length)
        )
    const worktreeCap = hasQuery
      ? PALETTE_SECTION_RENDER_CAP + (expandedSectionCaps['worktrees'] ?? 0)
      : baseWorktreeCap + (expandedSectionCaps['worktrees'] ?? 0)
    // Why: a typed query can match hundreds of rows; capping the rendered slice
    // is what keeps a one-character search from building an unbounded DOM.
    const worktrees = hasQuery
      ? capPaletteSection(worktreeItems, worktreeCap)
      : {
          visible: worktreeItems.slice(0, worktreeCap),
          overflowCount: Math.max(0, worktreeItems.length - worktreeCap)
        }
    const projectTargetsCap = PALETTE_SECTION_RENDER_CAP + (expandedSectionCaps['projects'] ?? 0)
    const projectTargets = capPaletteSection(hasQuery ? projectTargetItems : [], projectTargetsCap)
    const middleCap = PALETTE_SECTION_RENDER_CAP + (expandedSectionCaps['middle'] ?? 0)
    const middle = capPaletteSection(hasQuery ? middleItems : [], middleCap)
    // Why: only interleave when both primaries have hits — a lone section keeps the
    // full hard-capped list with no floor (empty headers / wasted slots).
    const multiPrimaryFirstScreen =
      hasQuery && openTabs.visible.length > 0 && worktrees.visible.length > 0
    const multiPrimaryLayout = multiPrimaryFirstScreen
      ? layoutMultiPrimaryPaletteSections<WorktreePaletteItem | OpenTabPaletteItem>({
          leadingItems: openTabsLeadSections ? openTabItems : worktreeItems,
          trailingItems: openTabsLeadSections ? worktreeItems : openTabItems,
          leadingPreviewCount:
            TYPED_QUERY_LEADING_PREVIEW +
            (expandedSectionCaps[openTabsLeadSections ? 'open-tabs' : 'worktrees'] ?? 0),
          leadingHardCap: openTabsLeadSections ? openTabsCap : worktreeCap,
          trailingHardCap: openTabsLeadSections ? worktreeCap : openTabsCap
        })
      : null

    return {
      visibleWorktreeItems: worktrees.visible as PaletteItem[],
      worktreeOverflowCount: worktrees.overflowCount,
      visibleProjectTargetItems: projectTargets.visible as PaletteItem[],
      projectTargetOverflowCount: projectTargets.overflowCount,
      visibleMiddleItems: middle.visible as PaletteItem[],
      middleOverflowCount: middle.overflowCount,
      visibleOpenTabItems: openTabs.visible as PaletteItem[],
      openTabOverflowCount: openTabs.overflowCount,
      multiPrimaryFirstScreen,
      multiPrimaryLayout
    }
  }, [
    expandedSectionCaps,
    worktreeItems,
    projectTargetItems,
    middleItems,
    openTabItems,
    recentTabItems,
    hasQuery,
    openTabsLeadSections
  ])

  // Why: badges number the snapshotted recent rows only — ⌘N is meaningless on a typed query.
  const recentTabShortcutIndexByItem = useMemo(
    () =>
      new Map(
        hasQuery ? [] : paletteSections.visibleOpenTabItems.map((item, index) => [item, index])
      ),
    [hasQuery, paletteSections]
  )

  // Why: the binding's own modifiers, minus its digit, so a remap renders honestly on every platform.
  const digitShortcutModifiers =
    useShortcutKeyComboDetails(DIGIT_INDEX_ACTION_ID)[0]?.keys.slice(0, -1) ?? []

  const {
    createWorktreeName: deferredCreateWorktreeName,
    showCreateAction: deferredShowCreateAction
  } = useMemo(
    () =>
      getWorktreePaletteCreateActionState({
        query: deferredQuery
      }),
    [deferredQuery]
  )
  const createWorktreeName = taskSourceUrl ? query.trim() : deferredCreateWorktreeName
  // Why: a task URL bypasses query deferral, so it arms create on its own.
  const showCreateAction = deferredShowCreateAction || taskSourceUrl !== null

  // Why: arm the lookup before Enter can target the newly rendered Linear row.
  useLayoutEffect(() => {
    const generation = ++linearIssueLookupGenerationRef.current
    linearIssueLookupRef.current = null
    if (!visible || !linearIssueUrlIntent) {
      setLinearIssuePreview(null)
      return
    }

    const state = useAppStore.getState()
    const workspaceTarget = getComposerDefaultWorkspaceTarget(state)
    const initialRepoId = workspaceTarget?.repoId ?? null
    const sourceContext = workspaceTarget
      ? buildTaskSourceContextFromRepo({
          provider: 'linear',
          projectId: workspaceTarget.projectId,
          repo: workspaceTarget.repo,
          projectHostSetupId: workspaceTarget.projectHostSetupId
        })
      : null
    const pendingPreview: CmdJLinearIssuePreview = {
      query: createWorktreeName,
      issue: null,
      loading: true,
      initialRepoId,
      sourceContext
    }
    setLinearIssuePreview(pendingPreview)

    const promise = lookupLinearIssueUrl({
      intent: linearIssueUrlIntent,
      knownStatus: state.linearStatus,
      sourceContext,
      fetchLinearIssue: state.fetchLinearIssue
    })
      .catch(() => null)
      .then(
        (issue): CmdJLinearIssuePreview => ({
          ...pendingPreview,
          issue,
          loading: false
        })
      )
    linearIssueLookupRef.current = { query: createWorktreeName, promise }
    void promise.then((preview) => {
      if (linearIssueLookupGenerationRef.current === generation) {
        setLinearIssuePreview(preview)
      }
    })

    return () => {
      if (linearIssueLookupGenerationRef.current === generation) {
        linearIssueLookupGenerationRef.current += 1
      }
    }
  }, [createWorktreeName, linearIssueUrlIntent, visible])

  useLayoutEffect(() => {
    const generation = ++githubLookupGenerationRef.current
    githubLookupRef.current = null
    if (!visible || !githubUrlLink) {
      setGithubWorkItemPreview(null)
      return
    }

    const state = useAppStore.getState()
    const workspaceTarget = getComposerDefaultWorkspaceTarget(state)
    const initialRepoId = workspaceTarget?.repoId ?? null
    const sourceContext = workspaceTarget
      ? buildTaskSourceContextFromRepo({
          provider: 'github',
          projectId: workspaceTarget.projectId,
          repo: workspaceTarget.repo,
          projectHostSetupId: workspaceTarget.projectHostSetupId
        })
      : null
    const pendingPreview: CmdJGitHubWorkItemPreview = {
      query: createWorktreeName,
      item: null,
      loading: true,
      initialRepoId,
      sourceContext
    }
    setGithubWorkItemPreview(pendingPreview)

    const promise = lookupCmdJGitHubUrlWorkItem({
      link: githubUrlLink,
      repo: workspaceTarget?.repo ?? null,
      sourceContext
    })
      .catch(() => null)
      .then(
        (item): CmdJGitHubWorkItemPreview => ({
          ...pendingPreview,
          item: item ?? null,
          loading: false
        })
      )
    githubLookupRef.current = { query: createWorktreeName, promise }
    void promise.then((preview) => {
      if (githubLookupGenerationRef.current === generation) {
        setGithubWorkItemPreview(preview)
      }
    })

    return () => {
      if (githubLookupGenerationRef.current === generation) {
        githubLookupGenerationRef.current += 1
      }
    }
  }, [createWorktreeName, githubUrlLink, visible])

  const taskUrlCreatePreview = useMemo(() => {
    if (!parsedTaskUrlCreatePreview) {
      return null
    }
    const preview =
      githubWorkItemPreview?.query === createWorktreeName ? githubWorkItemPreview : null
    return withResolvedCmdJGitHubPreview(
      parsedTaskUrlCreatePreview,
      preview?.item?.title ?? null,
      preview?.loading === true
    )
  }, [createWorktreeName, githubWorkItemPreview, parsedTaskUrlCreatePreview])

  const currentGitHubWorkItemPreview =
    githubWorkItemPreview?.query === createWorktreeName ? githubWorkItemPreview : null
  const currentLinearIssuePreview =
    linearIssuePreview?.query === createWorktreeName ? linearIssuePreview : null
  const [linearLoadingFeedbackQuery, setLinearLoadingFeedbackQuery] = useState<string | null>(null)
  useEffect(() => {
    if (!currentLinearIssuePreview?.loading) {
      setLinearLoadingFeedbackQuery(null)
      return
    }
    setLinearLoadingFeedbackQuery(null)
    const timer = window.setTimeout(
      () => setLinearLoadingFeedbackQuery(currentLinearIssuePreview.query),
      200
    )
    return () => window.clearTimeout(timer)
  }, [currentLinearIssuePreview?.loading, currentLinearIssuePreview?.query])
  const showLinearLoadingFeedback =
    currentLinearIssuePreview?.loading === true &&
    linearLoadingFeedbackQuery === currentLinearIssuePreview.query

  const listEntries = useMemo<PaletteListEntry[]>(() => {
    const entries: PaletteListEntry[] = []
    const {
      visibleWorktreeItems,
      visibleProjectTargetItems,
      visibleMiddleItems,
      visibleOpenTabItems,
      worktreeOverflowCount,
      projectTargetOverflowCount,
      middleOverflowCount,
      openTabOverflowCount,
      multiPrimaryFirstScreen,
      multiPrimaryLayout
    } = paletteSections
    const pushOverflowHint = (id: string, overflowCount: number, onSeeMore?: () => void): void => {
      if (overflowCount > 0) {
        entries.push({
          id,
          type: 'hint',
          label: translate('worktreeJumpPalette.renderCapOverflow', '{{value0}} more', {
            value0: overflowCount
          }),
          onSeeMore
        })
      }
    }
    // Why always: a lone search section still needs its label (mock single-section Open Tabs);
    // empty sections stay unlabeled because their push helpers short-circuit on zero rows.
    const showWorktreeHeader = visibleWorktreeItems.length > 0
    const showOpenTabsHeader = visibleOpenTabItems.length > 0
    const showProjectTargetHeader = visibleProjectTargetItems.length > 0
    const showMiddleHeader = visibleMiddleItems.length > 0

    // idSuffix: the interleaved layout re-emits a header for the section's remainder, which needs its own key.
    const pushOpenTabsHeader = (idSuffix = ''): void => {
      if (!showOpenTabsHeader) {
        return
      }
      entries.push({
        id: `__header_open_tabs__${idSuffix}`,
        type: 'section-header',
        label: hasQuery
          ? translate('auto.components.WorktreeJumpPalette.50a1d11d5b', 'Open Tabs')
          : translate(
              'auto.components.WorktreeJumpPalette.recentChatsTerminalsHeader',
              'Recent Chats & Terminals'
            )
      })
    }

    const pushWorktreesHeader = (idSuffix = ''): void => {
      if (!showWorktreeHeader) {
        return
      }
      entries.push({
        id: `__header_worktrees__${idSuffix}`,
        type: 'section-header',
        label: hasQuery
          ? translate('auto.components.WorktreeJumpPalette.worktreesHeader', 'Worktrees')
          : translate(
              'auto.components.WorktreeJumpPalette.recentWorktreesHeader',
              'Recent Worktrees'
            )
      })
    }

    const pushWorktreeSection = (): void => {
      if (visibleWorktreeItems.length === 0) {
        return
      }
      pushWorktreesHeader()
      appendPaletteListEntries(entries, visibleWorktreeItems)
      pushOverflowHint('__hint_worktree_overflow__', worktreeOverflowCount, () =>
        handleExpandSection('worktrees')
      )
    }

    const pushOpenTabSection = (): void => {
      if (visibleOpenTabItems.length === 0) {
        return
      }
      pushOpenTabsHeader()
      appendPaletteListEntries(entries, visibleOpenTabItems)
      pushOverflowHint('__hint_open_tab_overflow__', openTabOverflowCount, () =>
        handleExpandSection('open-tabs')
      )
    }

    const pushProjectAndMiddleSections = (): void => {
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
        pushOverflowHint('__hint_project_overflow__', projectTargetOverflowCount, () =>
          handleExpandSection('projects')
        )
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
        pushOverflowHint('__hint_middle_overflow__', middleOverflowCount, () =>
          handleExpandSection('middle')
        )
      }
    }

    // Why: a pasted issue/PR URL is decisive. Show linked worktrees first so
    // Enter jumps; keep create available underneath when the user wants a new one.
    if (taskSourceUrl) {
      if (visibleWorktreeItems.length > 0) {
        pushWorktreeSection()
      }
      if (showCreateAction) {
        entries.push({ id: CREATE_WORKTREE_ITEM_ID, type: 'create-worktree' })
      }
      return entries
    }

    if (!hasQuery) {
      // Why: the recent section leads the empty-query view; nothing else in this branch is populated.
      pushOpenTabSection()
      pushWorktreeSection()
      return entries
    }

    // Typed query with both open tabs and worktrees: soft-split so the trailing
    // primary is not buried under ~50 leading rows (see tmp/cmd-j-recommended.html).
    if (multiPrimaryFirstScreen && multiPrimaryLayout) {
      const leadingSectionKey = openTabsLeadSections ? 'open-tabs' : 'worktrees'
      const trailingSectionKey = openTabsLeadSections ? 'worktrees' : 'open-tabs'

      const leadingHintId = openTabsLeadSections
        ? '__hint_open_tab_overflow__'
        : '__hint_worktree_overflow__'
      const trailingHintId = openTabsLeadSections
        ? '__hint_worktree_overflow__'
        : '__hint_open_tab_overflow__'

      const pushLeadingHeader = (idSuffix = ''): void => {
        if (openTabsLeadSections) {
          pushOpenTabsHeader(idSuffix)
        } else {
          pushWorktreesHeader(idSuffix)
        }
      }
      const pushTrailingHeader = (idSuffix = ''): void => {
        if (openTabsLeadSections) {
          pushWorktreesHeader(idSuffix)
        } else {
          pushOpenTabsHeader(idSuffix)
        }
      }

      pushLeadingHeader()
      appendPaletteListEntries(entries, multiPrimaryLayout.leadingPreview as PaletteItem[])
      // Soft more for the leading section (rows resuming below + hard-cap tail).
      // Why: reveals the next batch into the leading preview so the user can
      // keep browsing tabs without having to scroll past the worktrees section.
      pushOverflowHint(leadingHintId, multiPrimaryLayout.leadingMoreCount, () =>
        handleExpandSection(leadingSectionKey)
      )
      pushTrailingHeader()
      // Floor first, then remaining leading rows, then trailing rest — same order
      // as orderMultiPrimaryPaletteItems / keyboard selection. Each remainder
      // re-emits its own header so no row sits under the other section's label.
      appendPaletteListEntries(entries, multiPrimaryLayout.trailingFloor as PaletteItem[])
      const hasLeadingRest = multiPrimaryLayout.leadingRest.length > 0
      if (hasLeadingRest) {
        pushLeadingHeader(CONTINUED_SECTION_HEADER_ID_SUFFIX)
        appendPaletteListEntries(entries, multiPrimaryLayout.leadingRest as PaletteItem[])
        pushOverflowHint(`${leadingHintId}_tail`, multiPrimaryLayout.leadingHardOverflowCount, () =>
          handleExpandSection(leadingSectionKey)
        )
      }
      if (multiPrimaryLayout.trailingRest.length > 0) {
        // Only re-label when the leading remainder split the trailing section.
        if (hasLeadingRest) {
          pushTrailingHeader(CONTINUED_SECTION_HEADER_ID_SUFFIX)
        }
        appendPaletteListEntries(entries, multiPrimaryLayout.trailingRest as PaletteItem[])
      }
      // Trailing rest is already on screen; only hard-cap overflow needs a hint.
      pushOverflowHint(trailingHintId, multiPrimaryLayout.trailingHardOverflowCount, () =>
        handleExpandSection(trailingSectionKey)
      )
      pushProjectAndMiddleSections()
      if (showCreateAction) {
        entries.push({ id: CREATE_WORKTREE_ITEM_ID, type: 'create-worktree' })
      }
      return entries
    }

    if (middleLeadsSections) {
      pushProjectAndMiddleSections()
    }
    if (openTabsLeadSections) {
      pushOpenTabSection()
    }
    pushWorktreeSection()
    if (!middleLeadsSections) {
      pushProjectAndMiddleSections()
    }
    if (!openTabsLeadSections) {
      pushOpenTabSection()
    }
    if (showCreateAction) {
      // Why: creating a workspace is the fallback for "nothing here matches", so it sits below every
      // real result — never above them, where it would steal the default selection from a match.
      entries.push({ id: CREATE_WORKTREE_ITEM_ID, type: 'create-worktree' })
    }
    return entries
  }, [
    handleExpandSection,
    hasQuery,
    middleLeadsSections,
    openTabsLeadSections,
    paletteSections,
    showCreateAction,
    taskSourceUrl
  ])

  // Why not entry.id directly: a duplicated persisted id would repeat a React key,
  // and the reconciler then leaves the extra row mounted as a frozen ghost.
  const listEntryRenderKeys = useMemo(
    () => buildPaletteListEntryRenderKeys(listEntries.map((entry) => entry.id)),
    [listEntries]
  )

  // Why derive from listEntries: multi-primary interleave must stay identical for
  // empty-state counts and keyboard selection — dual-path builders drifted before.
  const selectableItems = useMemo<PaletteItem[]>(
    () =>
      listEntries.filter(
        (entry): entry is PaletteItem =>
          entry.type !== 'section-header' &&
          entry.type !== 'hint' &&
          entry.type !== 'create-worktree'
      ),
    [listEntries]
  )

  // Why the render keys, not entry ids: cmdk selects by the rendered `value`, so the
  // allow-list has to name the same de-duplicated keys the rows carry.
  const selectionItemIds = useMemo(
    () => getWorktreePaletteSelectionItemIds(listEntries, listEntryRenderKeys),
    [listEntries, listEntryRenderKeys]
  )

  // Why passive, and why after the snapshot effect: it must record the head cmdk *had* while the
  // last frame was on screen, so the snapshot compares against that, not against its own result.
  useEffect(() => {
    autoSelectedItemIdRef.current = selectionItemIds[0] ?? null
  }, [selectionItemIds])

  // Why: "has any worktrees?" counts the full visible list (incl. current) so the palette never falsely claims empty. See docs/cmd-j-empty-query-ordering.md.
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
      // Why: capture browser focus before Radix Dialog steals it — by onOpenAutoFocus, activeElement is already the dialog.
      previousBrowserFocusTargetRef.current =
        activeTabType === 'browser' &&
        document.activeElement instanceof HTMLElement &&
        document.activeElement.closest('[data-orca-browser-address-bar="true"]')
          ? 'address-bar'
          : 'webview'
      // Why: same timing constraint — capture pre-dialog focus now so Escape can restore the exact input (not document.body).
      previousFocusElementRef.current =
        document.activeElement instanceof HTMLElement && document.activeElement !== document.body
          ? document.activeElement
          : null
      skipRestoreFocusRef.current = false
      setQuery('')
      setSelectedItemId('')
      selectionMovedByUserRef.current = false
      // Why: reset on open, not on close — closing races the fade-out, and a
      // mid-animation reset would flash unfiltered rows behind the overlay.
      setRawFilter(EMPTY_PALETTE_FILTER)
      listRef.current?.scrollTo(0, 0)
    }

    if (!visible && wasVisibleRef.current) {
      if (preserveCreateLookupOnCloseRef.current) {
        // Why: create closes the palette before GH resolves; reopening still invalidates the pending lookup above.
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
    showCreateAction,
    autoSelectCreateAction: taskSourceUrl !== null
  })

  // Why: cmdk writes its internal cursor *before* calling onValueChange. Dropping that
  // callback (e.g. while deferredQuery lags the keystroke) leaves internal state advanced
  // while the controlled `value` prop stays put — the next ArrowDown/Up then no-ops on
  // cmdk's Object.is guard, so keyboard navigation dies after typing. Always accept the
  // report so the cursor stays aligned; the deferred-commit effect below re-auto-selects
  // the new ranking head once the list the user sees actually changes.
  const handleCommandSelectionChange = useCallback((nextItemId: string) => {
    setSelectedItemId(nextItemId)
  }, [])

  // A late cmdk callback can restore the old cursor after handleQueryChange clears it.
  // Commit the new list head explicitly so a surviving stale row cannot stay highlighted.
  useLayoutEffect(() => {
    setSelectedItemId(
      getNextWorktreePaletteSelection({
        currentSelectedItemId: '',
        queryChanged: true,
        selectableItemIds: selectionItemIds,
        showCreateAction,
        autoSelectCreateAction: taskSourceUrl !== null
      })
    )
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- selection resets only when the deferred query commits, not on unrelated list churn.
  }, [deferredQuery])

  useEffect(() => {
    const isCreateWorkspaceHighlighted =
      commandSelectedItemId === CREATE_WORKTREE_ITEM_ID ||
      commandSelectedItemId === CREATE_WORKSPACE_QUICK_ACTION_ITEM_ID
    if (!visible || !isCreateWorkspaceHighlighted) {
      return
    }
    // Why: prewarm the composer's default repo while the row is highlighted, before Cmd+J opens it.
    prefetchCreateWorkspaceBaseForComposer()
  }, [commandSelectedItemId, prefetchCreateWorkspaceBaseForComposer, visible])

  const handleQueryChange = useCallback((nextQuery: string) => {
    setQuery(nextQuery)
    setSelectedItemId('')
    selectionMovedByUserRef.current = false
    listRef.current?.scrollTo(0, 0)
  }, [])
  const emojiInput = useWorkspaceEmojiShortcodeInput({
    inputRef,
    onValueChange: handleQueryChange,
    value: query
  })

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

  const focusFallbackSurface = useCallback(
    (preferredTarget?: HTMLElement | null) => {
      cancelFallbackFocusFrames()
      fallbackFocusOuterFrameRef.current = requestAnimationFrame(() => {
        fallbackFocusOuterFrameRef.current = null
        fallbackFocusInnerFrameRef.current = requestAnimationFrame(() => {
          fallbackFocusInnerFrameRef.current = null
          resolvePaletteFocusRestoreTarget(preferredTarget ?? null)?.focus({ preventScroll: true })
        })
      })
    },
    [cancelFallbackFocusFrames]
  )

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
        // Why: dismissing from a browser surface returns focus to that page, not the generic terminal/editor fallback.
        requestBrowserFocus({
          pageId: previousBrowserPageIdRef.current,
          target: previousBrowserFocusTargetRef.current
        })
        return
      }
      if (previousWorktreeIdRef.current) {
        // Why: restore the exact previously-focused surface on dismiss, not an arbitrary first match.
        focusFallbackSurface(previousFocusElementRef.current)
      }
    },
    [closeModal, focusFallbackSurface, requestBrowserFocus]
  )

  const handleSelectWorktree = useCallback(
    (worktree: Worktree) => {
      const current = useAppStore.getState().getKnownWorktreeById(worktree.id, worktree.hostId)
      if (!current) {
        toast.error(
          translate('auto.components.WorktreeJumpPalette.2c38630a01', 'Workspace no longer exists')
        )
        return
      }
      const activation = activateAndRevealWorktree(
        worktree.id,
        worktree.hostId ? { executionHostId: worktree.hostId } : {}
      )
      recordFeatureInteraction('cmd-j-workspace-open')
      skipRestoreFocusRef.current = true
      closeModal()
      setSelectedItemId('')
      // Why: #9939 — the unscoped fallback grabs the first terminal in the document, which is
      // often the worktree we just left, now hidden. Focus the destination's own tab instead.
      if (!queueWorkspaceActivationTerminalFocus(worktree.id, activation)) {
        focusFallbackSurface()
      }
    },
    [closeModal, focusFallbackSurface, recordFeatureInteraction]
  )

  const handleSelectBrowserPage = useCallback(
    (result: BrowserPaletteSearchResult) => {
      const activation = activateBrowserPagePaletteResult(result)
      if (activation.status === 'failed') {
        toast.error(
          activation.reason !== 'missing-worktree'
            ? translate(
                'auto.components.WorktreeJumpPalette.d7d496a451',
                'Browser page no longer exists'
              )
            : translate(
                'auto.components.WorktreeJumpPalette.2c38630a01',
                'Workspace no longer exists'
              )
        )
        return
      }
      recordFeatureInteraction('cmd-j-browser-page-open')
      skipRestoreFocusRef.current = true
      closeModal()
      setSelectedItemId('')
      requestBrowserFocus({ pageId: activation.pageId, target: activation.focusTarget })
    },
    [closeModal, recordFeatureInteraction, requestBrowserFocus]
  )

  const handleSelectSimulatorTab = useCallback(
    (result: SimulatorPaletteSearchResult) => {
      const activation = activateSimulatorTabPaletteResult(result)
      if (activation.status === 'failed') {
        toast.error(
          activation.reason === 'missing-tab'
            ? translate(
                'auto.components.WorktreeJumpPalette.7726ce9970',
                'Mobile emulator tab no longer exists'
              )
            : translate(
                'auto.components.WorktreeJumpPalette.2c38630a01',
                'Workspace no longer exists'
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
      void action
        .run(ctx)
        .then((result) => {
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
        .catch((error: unknown) => {
          if (!action.id.startsWith('plugin:')) {
            throw error
          }
          toast.error(
            translate(
              'auto.components.WorktreeJumpPalette.pluginCommandFailed',
              'Could not run the plugin command.'
            )
          )
        })
    },
    [buildQuickActionContext, closeModal, recordFeatureInteraction]
  )

  const handleSelectProjectTarget = useCallback(
    (result: CmdJProjectSearchResult) => {
      skipRestoreFocusRef.current = true
      // Why: selecting a project/repo group is sidebar navigation — reveal the row without activating an arbitrary workspace.
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
        // Why: #9939 — sidebar reveal keeps the same worktree, so restore the exact element the
        // user came from rather than the first terminal in the document.
        focusFallbackSurface(previousFocusElementRef.current)
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
        handleSelectWorktree(item.worktree)
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

  // Why a ref: the rows change on every agent tick, and re-subscribing on each one would tear down
  // the listener mid-chord; the handler only ever needs whatever is on screen right now.
  useLayoutEffect(() => {
    digitShortcutItemsRef.current = paletteSections.visibleOpenTabItems
  }, [paletteSections])

  // Why: main resolves the digit chord to a workspace jump; while the palette owns the keyboard it
  // means "activate recent row N" instead, addressing the snapshotted order the badges show.
  // Digits past the last badge fall through to nothing rather than switching behind the overlay.
  useEffect(() => {
    // Why the live query too: `hasQuery` is deferred, so between the keystroke and the deferred
    // commit a digit would still activate a recent row the user has already typed past.
    if (!visible || hasQuery || query.length > 0) {
      return
    }
    return subscribeCmdJRowIndexJump((index) => {
      const item = digitShortcutItemsRef.current[index]
      if (item) {
        handleSelectItem(item)
      }
    })
  }, [handleSelectItem, hasQuery, query.length, visible])

  const handleCreateWorktree = useCallback(() => {
    const trimmed = createWorktreeName.trim()
    if (liveQueryRef.current.trim() !== trimmed) {
      return
    }
    if (
      !isWorktreePaletteCreateActivationAllowed({
        hasTaskUrlIntent: taskSourceUrl !== null,
        hasCreateName: trimmed.length > 0,
        selectionMovedByUser: selectionMovedByUserRef.current
      })
    ) {
      return
    }
    const ghLink = parseGitHubIssueOrPRLink(trimmed)
    const ghNumber = parseGitHubIssueOrPRNumber(trimmed)

    const openComposer = (data: Record<string, unknown>): void => {
      skipRestoreFocusRef.current = true
      prefetchCreateWorkspaceBaseForComposer(
        typeof data.initialRepoId === 'string' ? data.initialRepoId : undefined
      )
      closeModal()
      recordFeatureInteraction('cmd-j-create-workspace')
      // Why: defer so Radix fully unmounts the palette dialog before the composer mounts, avoiding focus churn.
      queueMicrotask(() =>
        openModal('new-workspace-composer', { ...data, telemetrySource: 'command_palette' })
      )
    }

    if (linearIssueUrlIntent) {
      const openLinearIssueComposer = async (): Promise<void> => {
        const lookup = linearIssueLookupRef.current
        const preview = currentLinearIssuePreview?.loading
          ? await lookup?.promise
          : (currentLinearIssuePreview ?? (await lookup?.promise))
        if (
          lookup?.query !== trimmed ||
          linearIssueLookupRef.current !== lookup ||
          liveQueryRef.current.trim() !== trimmed
        ) {
          return
        }
        const composerData = preview?.issue
          ? (() => {
              const taskSourceContext = preview.sourceContext
                ? normalizeTaskSourceContext({
                    ...preview.sourceContext,
                    providerIdentity: {
                      provider: 'linear',
                      workspaceId: preview.issue.workspaceId ?? null,
                      workspaceName: preview.issue.workspaceName ?? null,
                      teamId: preview.issue.team.id,
                      teamKey: preview.issue.team.key
                    },
                    accountLabel: preview.issue.workspaceName ?? null
                  })
                : null
              return {
                prefilledName: getLinearIssueWorkspaceName(preview.issue),
                linkedWorkItem: buildLinearIssueLinkedWorkItem(preview.issue),
                ...(preview.initialRepoId ? { initialRepoId: preview.initialRepoId } : {}),
                ...(taskSourceContext ? { taskSourceContext } : {})
              }
            })()
          : preview?.initialRepoId
            ? { prefilledName: trimmed, initialRepoId: preview.initialRepoId }
            : { prefilledName: trimmed }

        if (useAppStore.getState().activeModal !== 'worktree-palette') {
          return
        }
        openComposer(composerData)
      }
      void openLinearIssueComposer()
      return
    }

    // Case 1: user pasted a GH/GitLab/Jira URL.
    // Why: GitHub uses the in-flight Cmd+J preview so Enter attaches the issue/PR
    // entity. GitLab/Jira still hand the raw URL to the composer. Linked worktrees
    // are listed above this row — selecting one jumps there.
    if (ghLink) {
      const openGitHubUrlComposer = async (): Promise<void> => {
        const lookup = githubLookupRef.current
        const preview = currentGitHubWorkItemPreview?.loading
          ? await lookup?.promise
          : (currentGitHubWorkItemPreview ?? (await lookup?.promise))
        if (
          lookup?.query !== trimmed ||
          githubLookupRef.current !== lookup ||
          liveQueryRef.current.trim() !== trimmed
        ) {
          return
        }
        const item = preview?.item ?? null
        const composerData = item
          ? (() => {
              const linkedWorkItem: LinkedWorkItemSummary = {
                provider: 'github',
                type: item.type,
                number: item.number,
                title: item.title,
                url: item.url,
                ...(item.repoId ? { repoId: item.repoId } : {})
              }
              return {
                prefilledName:
                  getLinkedWorkItemWorkspaceName(linkedWorkItem)?.seedName ??
                  getLinkedWorkItemSuggestedName({ title: item.title }),
                linkedWorkItem,
                initialGitHubWorkItem: item,
                ...(preview?.initialRepoId ? { initialRepoId: preview.initialRepoId } : {}),
                ...(preview?.sourceContext ? { taskSourceContext: preview.sourceContext } : {})
              }
            })()
          : preview?.initialRepoId
            ? { prefilledName: trimmed, initialRepoId: preview.initialRepoId }
            : { prefilledName: trimmed }

        if (useAppStore.getState().activeModal !== 'worktree-palette') {
          return
        }
        openComposer(composerData)
      }
      void openGitHubUrlComposer()
      return
    }

    if (taskUrlCreatePreview) {
      const state = useAppStore.getState()
      const eligibleRepos = state.repos.filter((r) => isGitRepoKind(r))
      const repoForLookup =
        (state.activeRepoId && eligibleRepos.find((r) => r.id === state.activeRepoId)) ||
        eligibleRepos[0]
      openComposer(
        repoForLookup
          ? { prefilledName: trimmed, initialRepoId: repoForLookup.id }
          : { prefilledName: trimmed }
      )
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
        skipRestoreFocusRef.current = true
        closeModal()
        // Why: #9939 — jumping to an already-open workspace must focus its own terminal.
        const activation = activateAndRevealWorktree(activeMatch.id)
        if (!queueWorkspaceActivationTerminalFocus(activeMatch.id, activation)) {
          focusFallbackSurface()
        }
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
      skipRestoreFocusRef.current = true
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
    currentGitHubWorkItemPreview,
    currentLinearIssuePreview,
    focusFallbackSurface,
    linearIssueUrlIntent,
    openModal,
    taskUrlCreatePreview,
    prefetchCreateWorkspaceBaseForComposer,
    recordFeatureInteraction,
    repoMap,
    taskSourceUrl
  ])

  const handleCloseAutoFocus = useCallback((e: Event) => {
    e.preventDefault()
  }, [])

  const focusPaletteInput = useCallback(() => {
    inputRef.current?.focus()
  }, [])

  // Why: the filter popover portals into the dialog element so the Dialog focus
  // trap treats it as inside; anchoring off the trailing slot finds it without
  // threading a ref through CommandDialog.
  const setDialogElementFromNode = useCallback((node: HTMLDivElement | null) => {
    setDialogElement(node?.closest<HTMLElement>('[role="dialog"]') ?? null)
  }, [])

  const handleOpenAutoFocus = useCallback((_event: Event) => {
    // No-op: focus handled in the visible effect before Radix; exists only to satisfy the prop API.
  }, [])

  // Why the split: on a query the render cap hides matches, so announcing the
  // visible slice under-reports "results found". The empty-query list renders
  // only its two capped sections, so there the visible count is the truth.
  const resultCount = hasQuery
    ? worktreeItems.length + projectTargetItems.length + middleItems.length + openTabItems.length
    : selectableItems.length
  const emptyState = (() => {
    // Why: a filter is the most likely reason a familiar query returns nothing,
    // so name it before any other explanation and point at the way out.
    if (filterActive) {
      return {
        title: translate(
          'worktreeJumpPalette.filter.emptyTitle',
          'No results match the active filter'
        ),
        subtitle: translate(
          'worktreeJumpPalette.filter.emptySubtitle',
          'Clear the filter above, or widen it to more hosts and projects.'
        )
      }
    }
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
    // Why: empty-query rows exclude the current worktree, so a single-worktree setup has zero switchable rows. See docs/cmd-j-empty-query-ordering.md.
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

  // Why the dialog is held in a variable: the provider below owns the only subscription to the hot
  // agent-status and pane-title maps, so an agent transition re-renders it and the dots inside it —
  // never this body. That only holds while these children keep their element identity across the
  // churn, which passing them straight through as `children` is what guarantees.
  const paletteDialog = (
    <CommandDialog
      open={visible}
      onOpenChange={handleOpenChange}
      shouldFilter={false}
      onOpenAutoFocus={handleOpenAutoFocus}
      onCloseAutoFocus={handleCloseAutoFocus}
      title={translate('auto.components.WorktreeJumpPalette.4ee378034d', 'Jump to...')}
      description={translate(
        'auto.components.WorktreeJumpPalette.2770f02910',
        'Search chats, terminals, worktrees, settings, and actions'
      )}
      overlayClassName="bg-black/55 backdrop-blur-[2px]"
      // Why max-h + calc list height: top offset + input + filter chips + footer
      // must stay on-screen on short windows; a bare 72vh list was clipping the chrome.
      contentClassName="top-[min(10%,4rem)] w-[900px] max-w-[96vw] max-h-[min(90vh,calc(100vh-1.5rem))] overflow-hidden rounded-xl border border-border/70 bg-background/96 shadow-[0_26px_84px_rgba(0,0,0,0.32)] backdrop-blur-xl"
      commandProps={{
        loop: true,
        value: commandSelectedItemId,
        onValueChange: handleCommandSelectionChange,
        className: 'bg-transparent',
        // Why capture here: Create must never be armed by cmdk's auto-select of the
        // only row — the user has to arrow onto it first.
        onKeyDownCapture: (event: React.KeyboardEvent) => {
          if (WORKTREE_PALETTE_SELECTION_MOVE_KEYS.has(event.key)) {
            selectionMovedByUserRef.current = true
          }
        }
      }}
    >
      <CommandInput
        ref={inputRef}
        placeholder={translate(
          'auto.components.WorktreeJumpPalette.27f10cca63',
          'Search chats, terminals, worktrees, settings, and actions...'
        )}
        value={query}
        onValueChange={emojiInput.handleValueChange}
        onClick={(event) => emojiInput.syncCursor(event.currentTarget)}
        onSelect={(event) => emojiInput.syncCursor(event.currentTarget)}
        onKeyDown={(event) => emojiInput.handleKeyDown(event)}
        wrapperClassName="mx-3 mt-3 rounded-lg border border-border/55 bg-muted/28 px-3.5 shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]"
        iconClassName="mr-2.5 h-4 w-4 text-muted-foreground/60"
        className="h-12 text-[14px] placeholder:text-muted-foreground/75"
        trailing={
          <div ref={setDialogElementFromNode}>
            <PaletteFilterMenu
              model={filterModel}
              filter={filter}
              onFilterChange={setRawFilter}
              onRequestInputFocus={focusPaletteInput}
              portalContainer={dialogElement}
            />
          </div>
        }
      />
      <WorkspaceEmojiSuggestionPopover
        anchorRef={inputRef}
        open={emojiInput.open}
        commandValue={emojiInput.commandValue}
        heading={translate('auto.components.new.workspace.SmartWorkspaceNameField.emoji', 'Emoji')}
        suggestions={emojiInput.suggestions}
        onCommandValueChange={emojiInput.onCommandValueChange}
        onSelect={emojiInput.selectSuggestion}
        onOpenChange={(open) => !open && emojiInput.close()}
        portalContainer={dialogElement}
        side="bottom"
        contentClassName="w-80"
      />
      <PaletteFilterChips model={filterModel} filter={filter} onFilterChange={setRawFilter} />
      <CommandList
        ref={listRef}
        // Why: a click inside the results is the other gesture that may arm Create.
        onPointerDownCapture={() => {
          selectionMovedByUserRef.current = true
        }}
        className="max-h-[min(600px,calc(100vh-14rem))] px-2.5 pb-2.5 pt-2"
      >
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
            {listEntries.map((entry, entryIndex) => {
              const renderKey = listEntryRenderKeys[entryIndex] ?? entry.id
              if (entry.type === 'section-header') {
                return (
                  <div
                    key={renderKey}
                    className="mx-0.5 mt-3 mb-1 px-3 text-[11px] font-medium uppercase tracking-wider text-muted-foreground/70"
                  >
                    {entry.label}
                  </div>
                )
              }

              if (entry.type === 'hint') {
                // Why: plain div (not CommandItem) so cmdk can't select it; arrow keys skip it via selectableItems.
                return (
                  <div
                    key={renderKey}
                    className="mx-0.5 mt-1 flex items-center gap-2 px-3 py-1.5 text-[12px] text-muted-foreground"
                  >
                    <span className="truncate">{entry.label}</span>
                    {entry.onSeeMore ? (
                      <Button
                        type="button"
                        variant="outline"
                        size="xs"
                        className="h-6 shrink-0 px-2 text-xs font-medium text-foreground hover:bg-accent"
                        onClick={(event) => {
                          event.preventDefault()
                          event.stopPropagation()
                          entry.onSeeMore?.()
                          inputRef.current?.focus()
                        }}
                      >
                        {translate('worktreeJumpPalette.seeMore', 'See more')}
                      </Button>
                    ) : null}
                  </div>
                )
              }

              if (entry.type === 'create-worktree') {
                const linearPreviewIssue = currentLinearIssuePreview?.issue ?? null
                const linearPreviewLoading =
                  linearIssueUrlIntent !== null && currentLinearIssuePreview?.loading !== false
                return (
                  <PaletteCreateWorktreeRow
                    key={renderKey}
                    className={cn(JUMP_PALETTE_ITEM_CLASSNAME, 'mt-1 py-1.5')}
                    createWorktreeName={createWorktreeName}
                    linearIdentifier={linearIssueUrlIntent?.identifier ?? null}
                    linearIssue={linearPreviewIssue}
                    linearPending={linearPreviewLoading}
                    showLinearLoadingFeedback={showLinearLoadingFeedback}
                    taskUrlPreview={taskUrlCreatePreview}
                    onSelect={handleCreateWorktree}
                  />
                )
              }

              if (entry.type === 'worktree') {
                const worktree = entry.worktree
                const repo = resolveRepoForWorktree(worktree)
                const repoName = repo?.displayName ?? ''
                // Why: both must match searchWorktrees' resolution, or highlight ranges land on
                // the wrong text — and a branch-less row would throw here before search ever ran.
                const branch = resolveWorktreeBranchLabel(worktree)
                const worktreeLabel = resolveWorktreeDisplayName(worktree)
                const isCurrentWorktree = isPaletteCurrentWorktree(
                  worktree,
                  activeWorktreeId,
                  activeWorkspaceExecutionHostId
                )
                // Why: runtime-owned SSH targets have relay health owned by the runtime layer — don't show a false disconnected.
                const sshConnectionId =
                  repo?.connectionId && !isRuntimeOwnedSshTargetId(repo.connectionId)
                    ? repo.connectionId
                    : null
                const sshStatus = sshConnectionId
                  ? (sshConnectionStates.get(sshConnectionId)?.status ?? 'disconnected')
                  : null
                const isSshDisconnected = sshStatus != null && sshStatus !== 'connected'
                const sessionAge = formatPaletteSessionAge(worktree.lastActivityAt, paletteNowMs)
                return (
                  <CommandItem
                    key={renderKey}
                    value={renderKey}
                    onSelect={() => handleSelectItem(entry)}
                    data-current={isCurrentWorktree ? 'true' : undefined}
                    className={cn(JUMP_PALETTE_ITEM_CLASSNAME, 'py-2.5')}
                  >
                    <div className="flex h-5 w-4 shrink-0 items-center justify-center self-start">
                      <PaletteWorktreeStatusDot worktree={worktree} />
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
                            <PaletteOpenTabWorktreeRailLabel
                              name={worktreeLabel}
                              matchRanges={entry.match.displayNameRanges}
                              worktree={worktree}
                              slot="palette-worktree-name"
                              className="truncate text-[14px] font-semibold text-foreground"
                            />
                            {sessionAge ? (
                              <span
                                aria-label={translate(
                                  'auto.components.WorktreeJumpPalette.lastActiveTime',
                                  'Last active {{value0}} ago',
                                  { value0: sessionAge }
                                )}
                                className="shrink-0 text-[11px] font-medium tabular-nums text-muted-foreground/70"
                              >
                                {sessionAge}
                              </span>
                            ) : null}
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
                            {branch.trim().length > 0 ? (
                              <>
                                <span className="shrink-0 text-muted-foreground/45">·</span>
                                <PaletteOpenTabWorktreeRailLabel
                                  name={branch}
                                  matchRanges={entry.match.branchRanges}
                                  worktree={worktree}
                                  slot="palette-worktree-branch"
                                  className="truncate text-[12px] font-medium text-muted-foreground/92"
                                />
                              </>
                            ) : null}
                          </div>
                          {entry.match.supportingText && (
                            <div className="mt-1.5 flex min-w-0 items-center gap-2 text-[12px] leading-5 text-muted-foreground/88">
                              <span
                                aria-label={entry.match.supportingText.accessibilityLabel}
                                className="inline-flex h-[18px] shrink-0 items-center rounded border border-border bg-foreground/[0.04] px-1.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground"
                              >
                                {getPaletteSupportingTextLabel(
                                  entry.match.supportingText.labelKind
                                )}
                              </span>
                              <span className="truncate">
                                <HighlightedText
                                  text={entry.match.supportingText.text}
                                  matchRanges={entry.match.supportingText.matchRanges}
                                />
                              </span>
                            </div>
                          )}
                        </div>
                        <div className="flex shrink-0 items-center gap-1.5">
                          {repoName && (
                            <span className="inline-flex max-w-[180px] items-center gap-1.5 rounded-md border border-border bg-muted px-2 py-1 text-[11px] font-semibold leading-none text-foreground">
                              <RepoBadgeMark color={repo?.badgeColor} />
                              <span className="truncate">
                                <HighlightedText
                                  text={repoName}
                                  matchRanges={entry.match.repoRanges}
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

              if (entry.type === 'project-target') {
                const result = entry.result
                const isProject = result.kind === 'project'
                const badgeLabel = isProject
                  ? translate('auto.components.WorktreeJumpPalette.projectBadge', 'Project')
                  : translate('auto.components.WorktreeJumpPalette.repoGroupBadge', 'Repo group')
                return (
                  <CommandItem
                    key={renderKey}
                    value={renderKey}
                    onSelect={() => handleSelectItem(entry)}
                    className={cn(JUMP_PALETTE_ITEM_CLASSNAME, 'py-2.5')}
                  >
                    <div className="flex h-5 w-4 shrink-0 items-center justify-center self-start text-muted-foreground/85">
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
                    key={renderKey}
                    value={renderKey}
                    onSelect={() => handleSelectItem(entry)}
                    className={cn(JUMP_PALETTE_ITEM_CLASSNAME, 'py-2.5')}
                  >
                    <div className="flex h-5 w-4 shrink-0 items-center justify-center self-start text-muted-foreground/85">
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
                const sessionAge = formatPaletteSessionAge(result.lastActiveAt, paletteNowMs)
                const workspaceTabWorktree = resolveWorktree(
                  result.worktreeId,
                  result.executionHostId
                )
                const workspaceTabRepo = workspaceTabWorktree
                  ? resolveRepoForWorktree(workspaceTabWorktree)
                  : undefined
                const workspaceTabRepoName = workspaceTabRepo?.displayName ?? result.repoName
                const workspaceTabFallback =
                  result.contentType === 'terminal' && result.occupantAgent ? (
                    <span
                      className="inline-flex"
                      data-agent-icon={result.occupantAgent}
                      aria-hidden="true"
                    >
                      <AgentIcon agent={result.occupantAgent} size={14} />
                    </span>
                  ) : result.contentType === 'terminal' ? (
                    <SquareTerminal className="size-3.5" aria-hidden="true" />
                  ) : (
                    <FileText className="size-3.5" aria-hidden="true" />
                  )
                // Why regardless of query: a searched-for tab is exactly when you need to know it's
                // still working — the map covers every open tab, not just the recent section.
                const recentRow = recentTabRowByItem.get(entry) ?? null

                return (
                  <CommandItem
                    key={renderKey}
                    value={renderKey}
                    onSelect={() => handleSelectItem(entry)}
                    className={cn(JUMP_PALETTE_ITEM_CLASSNAME, 'py-2.5')}
                  >
                    <div className="flex h-5 w-4 shrink-0 items-center justify-center self-start text-muted-foreground/85">
                      <PaletteRecentTabStatusDot row={recentRow} fallback={workspaceTabFallback} />
                    </div>
                    <div className="min-w-0 flex-1 overflow-hidden">
                      <div className="flex items-center justify-between gap-2.5">
                        <div className="min-w-0 flex-1 overflow-hidden">
                          <PaletteOpenTabPrimaryLine
                            title={result.title}
                            titleRanges={result.titleRanges}
                            secondaryText={result.secondaryText}
                            secondaryRanges={result.secondaryRanges}
                            sessionAge={sessionAge}
                            leadingBadges={
                              <>
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
                              </>
                            }
                          />
                        </div>
                        <div className="flex shrink-0 items-center gap-1.5">
                          <PaletteOpenTabWorktreeRailLabel
                            name={result.worktreeName}
                            matchRanges={result.worktreeRanges}
                            worktree={workspaceTabWorktree}
                            className="max-w-[280px] truncate text-[12px] font-medium text-muted-foreground"
                          />
                          {workspaceTabRepoName && (
                            <span className="inline-flex max-w-[180px] items-center gap-1.5 rounded-md border border-border bg-muted px-2 py-1 text-[11px] font-semibold leading-none text-foreground">
                              <RepoBadgeMark color={workspaceTabRepo?.badgeColor} />
                              <span className="truncate">
                                <HighlightedText
                                  text={workspaceTabRepoName}
                                  matchRanges={result.repoRanges}
                                />
                              </span>
                            </span>
                          )}
                          <PaletteRowShortcutBadge
                            index={recentTabShortcutIndexByItem.get(entry)}
                            modifierKeys={digitShortcutModifiers}
                          />
                        </div>
                      </div>
                    </div>
                  </CommandItem>
                )
              }

              if (entry.type === 'simulator-tab') {
                const result = entry.result
                const simulatorWorktree = resolveWorktree(result.worktreeId, result.executionHostId)
                const simulatorRepo = simulatorWorktree
                  ? resolveRepoForWorktree(simulatorWorktree)
                  : undefined
                const simulatorRepoName = simulatorRepo?.displayName ?? result.repoName
                const sessionAge = formatPaletteSessionAge(
                  result.lastActiveAt ?? null,
                  paletteNowMs
                )

                return (
                  <CommandItem
                    key={renderKey}
                    value={renderKey}
                    onSelect={() => handleSelectItem(entry)}
                    className={cn(JUMP_PALETTE_ITEM_CLASSNAME, 'py-2.5')}
                  >
                    <div className="flex h-5 w-4 shrink-0 items-center justify-center self-start text-muted-foreground/85">
                      <Smartphone className="size-3.5" aria-hidden="true" />
                    </div>
                    <div className="min-w-0 flex-1 overflow-hidden">
                      <div className="flex items-center justify-between gap-2.5">
                        <div className="min-w-0 flex-1 overflow-hidden">
                          <PaletteOpenTabPrimaryLine
                            title={result.title}
                            titleRanges={result.titleRanges}
                            secondaryText={result.secondaryText}
                            secondaryRanges={result.secondaryRanges}
                            sessionAge={sessionAge}
                            leadingBadges={
                              <>
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
                              </>
                            }
                          />
                        </div>
                        <div className="flex shrink-0 items-center gap-1.5">
                          <PaletteOpenTabWorktreeRailLabel
                            name={result.worktreeName}
                            matchRanges={result.worktreeRanges}
                            worktree={simulatorWorktree}
                            className="max-w-[280px] truncate text-[12px] font-medium text-muted-foreground"
                          />
                          {simulatorRepoName && (
                            <span className="inline-flex max-w-[180px] items-center gap-1.5 rounded-md border border-border bg-muted px-2 py-1 text-[11px] font-semibold leading-none text-foreground">
                              <RepoBadgeMark color={simulatorRepo?.badgeColor} />
                              <span className="truncate">
                                <HighlightedText
                                  text={simulatorRepoName}
                                  matchRanges={result.repoRanges}
                                />
                              </span>
                            </span>
                          )}
                          <PaletteRowShortcutBadge
                            index={recentTabShortcutIndexByItem.get(entry)}
                            modifierKeys={digitShortcutModifiers}
                          />
                        </div>
                      </div>
                    </div>
                  </CommandItem>
                )
              }

              const result = entry.result
              const browserWorktree = resolveWorktree(result.worktreeId, result.executionHostId)
              const browserRepo = browserWorktree
                ? resolveRepoForWorktree(browserWorktree)
                : undefined
              const browserRepoName = browserRepo?.displayName ?? result.repoName
              const sessionAge = formatPaletteSessionAge(result.lastActiveAt ?? null, paletteNowMs)

              return (
                <CommandItem
                  key={renderKey}
                  value={renderKey}
                  onSelect={() => handleSelectItem(entry)}
                  className={cn(JUMP_PALETTE_ITEM_CLASSNAME, 'py-2.5')}
                >
                  <div className="flex h-5 w-4 shrink-0 items-center justify-center self-start text-muted-foreground/85">
                    <Globe className="size-3.5" aria-hidden="true" />
                  </div>
                  <div className="min-w-0 flex-1 overflow-hidden">
                    <div className="flex items-center justify-between gap-2.5">
                      <div className="min-w-0 flex-1 overflow-hidden">
                        <PaletteOpenTabPrimaryLine
                          title={result.title}
                          titleRanges={result.titleRanges}
                          secondaryText={result.secondaryText}
                          secondaryRanges={result.secondaryRanges}
                          sessionAge={sessionAge}
                          leadingBadges={
                            <>
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
                            </>
                          }
                        />
                      </div>
                      <div className="flex shrink-0 items-center gap-1.5">
                        <PaletteOpenTabWorktreeRailLabel
                          name={result.worktreeName}
                          matchRanges={result.worktreeRanges}
                          worktree={browserWorktree}
                          className="max-w-[280px] truncate text-[12px] font-medium text-muted-foreground"
                        />
                        {browserRepoName && (
                          <span className="inline-flex max-w-[180px] items-center gap-1.5 rounded-md border border-border bg-muted px-2 py-1 text-[11px] font-semibold leading-none text-foreground">
                            <RepoBadgeMark color={browserRepo?.badgeColor} />
                            <span className="truncate">
                              <HighlightedText
                                text={browserRepoName}
                                matchRanges={result.repoRanges}
                              />
                            </span>
                          </span>
                        )}
                        <PaletteRowShortcutBadge
                          index={recentTabShortcutIndexByItem.get(entry)}
                          modifierKeys={digitShortcutModifiers}
                        />
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
          <FooterKey>{translate('worktreeJumpPalette.filter.tabKey', 'Tab')}</FooterKey>
          <span>{translate('worktreeJumpPalette.filter.label', 'Filter')}</span>
        </div>
      </div>
      <div aria-live="polite" className="sr-only">
        {filterActive
          ? `${translate('worktreeJumpPalette.filter.ariaActive', 'Filter: {{value0}} active.', {
              value0: getPaletteFilterSelectionCount(filter)
            })} `
          : ''}
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

  return (
    <TooltipProvider delayDuration={400}>
      <PaletteLiveStatusProvider active={paletteStatusInputsActive}>
        {paletteDialog}
      </PaletteLiveStatusProvider>
    </TooltipProvider>
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
    case 'mr':
      return translate('worktreeJumpPalette.matchLabel.mr', 'MR')
    case 'task':
      return translate('worktreeJumpPalette.matchLabel.task', 'Task')
    case 'automation':
      return translate('worktreeJumpPalette.matchLabel.automation', 'Run')
  }
}
