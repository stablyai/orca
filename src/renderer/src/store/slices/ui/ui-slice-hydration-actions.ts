import type { UISlice, UISliceGet, UISliceSet } from './ui-slice-contract'
import type { AppState } from '../../types'
import type { PersistedUIState } from '../../../../../shared/persisted-ui-state-types'
import { normalizeRightSidebarRoute } from '../../right-sidebar-route'
import {
  applyManualRepoOrder,
  normalizeManualRepoOrder
} from '../../../../../shared/manual-repo-order'
import { normalizeWorkspaceCleanupBrowseState } from '../../../../../shared/workspace-cleanup-browse-state'
import {
  normalizeExecutionHostScope,
  normalizeExecutionHostOrder,
  normalizeVisibleExecutionHostIds
} from '../../../../../shared/execution-host'
import { normalizeFeatureInteractions } from '../../../../../shared/feature-interactions'
import { normalizeContextualTourIds } from '../../../../../shared/contextual-tours'
import { normalizeFeatureTipIds } from '../../../../../shared/feature-tips'
import {
  DEFAULT_HIDE_SLEEPING_WORKSPACES,
  normalizeWorktreeCardProperties,
  normalizeAgentActivityDisplayMode
} from '../../../../../shared/constants'
import {
  clampWorkspaceBoardColumnWidth,
  clampWorkspaceBoardOpacity,
  normalizeWorkspaceStatuses
} from '../../../../../shared/workspace-statuses'
import { PET_SIZE_DEFAULT, PET_SIZE_MAX, PET_SIZE_MIN } from '../../../../../shared/pet-types'
import { clampMarkdownTocPanelWidth } from '../../../../../shared/markdown-toc-panel-width'
import { clampCombinedDiffFileTreeWidth } from '../../../../../shared/combined-diff-file-tree-width'
import { parsePersistedAutomationHostFilter } from '../../../../../shared/automation-host-filter'
import { normalizeUsagePercentageDisplay } from '../../../../../shared/usage-percentage-display'
import { normalizeStatusBarUsageMode } from '../../../../../shared/status-bar-usage-mode'
import { normalizeBrowserPageZoomLevel } from '../../../../../shared/browser-page-zoom'
import { normalizeKagiSessionLink } from '../../../../../shared/browser-url'
import { isReleaseChannel } from '../../../../../shared/release-channel'
import type { StatusBarItem } from '../../../../../shared/ui-chrome-types'
import {
  filterSetupScriptPromptDismissalsToValidRepos,
  sanitizeSetupScriptPromptDismissals
} from '../../../lib/setup-script-prompt'
import { isBundledPetId, DEFAULT_PET_ID } from '../../../components/pet/pet-models'
import { getRepoHostIdentity } from '../repo-host-identity'
import type { PersistedUIWriteBaseline } from '../persisted-ui-write-baseline'
import {
  capturePersistedUIWriteBaseline,
  diffPersistedUIWriteFields
} from '../persisted-ui-write-baseline'
import {
  hydrateTrustedOrcaHooks,
  normalizeHydratedVisibleWorkspaceHostIds,
  preserveStringArrayIdentity,
  sanitizeHydratedActiveView,
  sanitizePersistedRepoIds,
  sanitizeShowDotfilesByWorktree,
  sanitizeWorkspaceCleanupDismissals,
  sanitizePersistedSidebarWidth,
  hydratedUIPartialMatchesState,
  migrateStatusBarItems,
  clampPetSize
} from './ui-slice-hydration-sanitizers'
import { hydrateAgentReadState, sanitizeTaskResumeState } from './ui-slice-hydration-values'

const MAX_LEFT_SIDEBAR_WIDTH = 500
const MAX_RIGHT_SIDEBAR_WIDTH = 4000
const DEFAULT_ON_PORTS_STATUS_BAR_ITEM: StatusBarItem = 'ports'
const DEFAULT_ON_KIMI_STATUS_BAR_ITEM: StatusBarItem = 'kimi'
const DEFAULT_ON_MINIMAX_STATUS_BAR_ITEM: StatusBarItem = 'minimax'
const DEFAULT_ON_ANTIGRAVITY_STATUS_BAR_ITEM: StatusBarItem = 'antigravity'
const DEFAULT_ON_GROK_STATUS_BAR_ITEM: StatusBarItem = 'grok'

function hydrateStatusBarItems(ui: PersistedUIState): StatusBarItem[] {
  let items = migrateStatusBarItems(ui.statusBarItems)
  const defaults = [
    ['_portsStatusBarDefaultAdded', DEFAULT_ON_PORTS_STATUS_BAR_ITEM],
    ['_kimiStatusBarDefaultAdded', DEFAULT_ON_KIMI_STATUS_BAR_ITEM],
    ['_minimaxStatusBarDefaultAdded', DEFAULT_ON_MINIMAX_STATUS_BAR_ITEM],
    ['_antigravityStatusBarDefaultAdded', DEFAULT_ON_ANTIGRAVITY_STATUS_BAR_ITEM],
    ['_grokStatusBarDefaultAdded', DEFAULT_ON_GROK_STATUS_BAR_ITEM]
  ] as const
  for (const [flag, item] of defaults) {
    if (!ui[flag] && !items.includes(item)) {
      items = [...items, item]
    }
  }
  if (typeof window !== 'undefined' && defaults.some(([flag]) => !ui[flag])) {
    window.api.ui
      .set({ statusBarItems: items, ...Object.fromEntries(defaults.map(([flag]) => [flag, true])) })
      .catch(console.error)
  }
  return items
}

export function createUiHydrationActions(set: UISliceSet, _get: UISliceGet): Partial<UISlice> {
  return {
    hydratePersistedUI: (ui, source = 'sync') =>
      set((s) => {
        const manualRepoOrder = normalizeManualRepoOrder(ui.manualRepoOrder)
        const orderedRepos = applyManualRepoOrder(s.repos, manualRepoOrder)
        const validRepoIds = new Set(s.repos.map((repo) => repo.id))
        const validRepoHostIdentities = new Set(s.repos.map(getRepoHostIdentity))
        const persistedFilterRepoIds = sanitizePersistedRepoIds(ui.filterRepoIds)
        const persistedAgentsFilterRepoIds = sanitizePersistedRepoIds(ui.agentsFilterRepoIds)
        // Why: pre-rename builds used sidekick* keys; read as fallback only so new pet* writes win after upgrade.
        const customPets = Array.isArray(ui.customPets)
          ? ui.customPets
          : Array.isArray(ui.customSidekicks)
            ? ui.customSidekicks
            : []
        const petId = ui.petId ?? ui.sidekickId
        // Migration: one-shot old-'recent'→'smart' runs in main (_sortBySmartMigrated), not here, so a deliberate 'recent' choice survives restart.
        const sortBy = ui.sortBy
        const statusBarItemsWithGrok = hydrateStatusBarItems(ui)
        const rightSidebarRoute = normalizeRightSidebarRoute(
          ui.rightSidebarTab,
          ui.rightSidebarExplorerView
        )
        const hydrated = {
          // Why: persisted widths may be stale/corrupt/hand-edited; clamp during hydration so invalid values can't break layout.
          sidebarWidth: sanitizePersistedSidebarWidth(
            ui.sidebarWidth,
            s.sidebarWidth,
            MAX_LEFT_SIDEBAR_WIDTH
          ),
          rightSidebarWidth: sanitizePersistedSidebarWidth(
            ui.rightSidebarWidth,
            s.rightSidebarWidth,
            MAX_RIGHT_SIDEBAR_WIDTH
          ),
          markdownTocPanelWidth: clampMarkdownTocPanelWidth(
            ui.markdownTocPanelWidth,
            undefined,
            s.markdownTocPanelWidth
          ),
          combinedDiffFileTreeWidth: clampCombinedDiffFileTreeWidth(
            ui.combinedDiffFileTreeWidth,
            undefined,
            s.combinedDiffFileTreeWidth
          ),
          rightSidebarOpen: typeof ui.rightSidebarOpen === 'boolean' ? ui.rightSidebarOpen : true,
          rightSidebarTab: rightSidebarRoute.rightSidebarTab,
          rightSidebarExplorerView: rightSidebarRoute.rightSidebarExplorerView,
          groupBy: (ui.groupBy as UISlice['groupBy'] | 'parent') === 'parent' ? 'repo' : ui.groupBy,
          sortBy,
          // Why: main-process getUI() already normalized this (defaulting to 'manual'); read it through without migrating.
          projectOrderBy: ui.projectOrderBy,
          // Why: Active-only was retired; force the old flag off so an old profile can't invisibly narrow the workspace list.
          showActiveOnly: false,
          // Why: ignore older positive-form keys so old profiles start from the new default (sleeping workspaces visible).
          showSleepingWorkspaces: !(ui.hideSleepingWorkspaces ?? DEFAULT_HIDE_SLEEPING_WORKSPACES),
          workspaceHostScope: normalizeExecutionHostScope(ui.workspaceHostScope),
          visibleWorkspaceHostIds: normalizeHydratedVisibleWorkspaceHostIds(ui),
          workspaceHostOrder: normalizeExecutionHostOrder(ui.workspaceHostOrder),
          // Why: a malformed or legacy filter value must degrade to All hosts, never throw during hydration.
          automationHostFilter: parsePersistedAutomationHostFilter(ui.automationHostFilter),
          manualRepoOrder,
          // Why: apply the desktop-owned overlay immediately since UI state can arrive after a catalog or from another client.
          repos: orderedRepos,
          hideDefaultBranchWorkspace: ui.hideDefaultBranchWorkspace ?? false,
          hideAutomationGeneratedWorkspaces: ui.hideAutomationGeneratedWorkspaces === true,
          hideCliCreatedWorkspaces: ui.hideCliCreatedWorkspaces === true,
          hideDetachedHeadWorkspaces: ui.hideDetachedHeadWorkspaces === true,
          hideWorkspacesFromOtherDevices: ui.hideWorkspacesFromOtherDevices === true,
          // Why !== false: profiles written before #8873 have no key, and they are
          // precisely the ones showing the bug, so absence must mean "exempt".
          alwaysShowDefaultBranchWorkspace: ui.alwaysShowDefaultBranchWorkspace !== false,
          showDotfilesByWorktree: sanitizeShowDotfilesByWorktree(ui.showDotfilesByWorktree),
          // Why: startup hydrates UI before repo catalogs, so defer repo-filter validation to the all-host refresh.
          filterRepoIds:
            validRepoIds.size === 0
              ? persistedFilterRepoIds
              : persistedFilterRepoIds.filter((repoId) => validRepoIds.has(repoId)),
          agentsVisibleHostIds: preserveStringArrayIdentity(
            s.agentsVisibleHostIds,
            normalizeVisibleExecutionHostIds(ui.agentsVisibleHostIds)
          ),
          agentsFilterRepoIds: preserveStringArrayIdentity(
            s.agentsFilterRepoIds,
            validRepoIds.size === 0
              ? persistedAgentsFilterRepoIds
              : persistedAgentsFilterRepoIds.filter((repoId) => validRepoIds.has(repoId))
          ),
          agentsShowChildAgents: ui.agentsShowChildAgents === true,
          agentsCompactMode: ui.agentsCompactMode !== false,
          collapsedGroups: new Set(ui.collapsedGroups ?? []),
          uiZoomLevel: ui.uiZoomLevel ?? 0,
          editorFontZoomLevel: ui.editorFontZoomLevel ?? 0,
          worktreeCardProperties: normalizeWorktreeCardProperties(ui.worktreeCardProperties),
          _worktreeCardModeDefaulted: ui._worktreeCardModeDefaulted === true,
          agentActivityDisplayMode: normalizeAgentActivityDisplayMode(ui.agentActivityDisplayMode),
          workspaceStatuses: normalizeWorkspaceStatuses(ui.workspaceStatuses),
          workspaceBoardOpacity: clampWorkspaceBoardOpacity(ui.workspaceBoardOpacity),
          workspaceBoardColumnWidth: clampWorkspaceBoardColumnWidth(ui.workspaceBoardColumnWidth),
          syncTaskStatusFromWorkspaceBoard: ui.syncTaskStatusFromWorkspaceBoard === true,
          statusBarItems: statusBarItemsWithGrok,
          statusBarVisible: ui.statusBarVisible ?? true,
          usagePercentageDisplay: normalizeUsagePercentageDisplay(ui.usagePercentageDisplay),
          statusBarUsageMode: normalizeStatusBarUsageMode(ui.statusBarUsageMode),
          // Why: default true so existing users see the pet on first enabling the flag; only an explicit Hide persists false.
          petVisible: ui.petVisible ?? ui.sidekickVisible ?? true,
          petSize: clampPetSize(ui.petSize ?? ui.sidekickSize ?? PET_SIZE_DEFAULT, {
            min: PET_SIZE_MIN,
            max: PET_SIZE_MAX,
            fallback: PET_SIZE_DEFAULT
          }),
          customPets,
          // Why: fall back to default when the persisted id is unknown (e.g. custom pet removed elsewhere) so the overlay renders.
          petId: ((): string => {
            const id = petId
            if (typeof id !== 'string') {
              return DEFAULT_PET_ID
            }
            if (isBundledPetId(id)) {
              return id
            }
            if (customPets.some((m) => m.id === id)) {
              return id
            }
            return DEFAULT_PET_ID
          })(),
          dismissedUpdateVersion: ui.dismissedUpdateVersion ?? null,
          // Why: a persisted value from a build that knew a different channel set
          // would otherwise survive as-is; activeChannel only falls back on null,
          // so an unknown string reaches listBuilds and the segmented control.
          releaseChannelOverride: isReleaseChannel(ui.releaseChannelOverride)
            ? ui.releaseChannelOverride
            : null,
          updateReassuranceSeen: ui.updateReassuranceSeen ?? false,
          osc52ClipboardDefaultOnNoticePending: ui.osc52ClipboardDefaultOnNoticePending === true,
          browserDefaultUrl: ui.browserDefaultUrl ?? null,
          browserDefaultSearchEngine: ui.browserDefaultSearchEngine ?? null,
          browserDefaultZoomLevel: normalizeBrowserPageZoomLevel(ui.browserDefaultZoomLevel),
          browserKagiSessionLink: normalizeKagiSessionLink(ui.browserKagiSessionLink ?? ''),
          taskResumeState: sanitizeTaskResumeState(ui.taskResumeState),
          featureTipsSeenIds: normalizeFeatureTipIds(ui.featureTipsSeenIds),
          featureInteractions: normalizeFeatureInteractions(ui.featureInteractions),
          contextualToursSeenIds: normalizeContextualTourIds(ui.contextualToursSeenIds),
          contextualToursAutoEligible:
            typeof ui.contextualToursAutoEligible === 'boolean'
              ? ui.contextualToursAutoEligible
              : null,
          trustedOrcaHooks: hydrateTrustedOrcaHooks(ui.trustedOrcaHooks, validRepoIds),
          setupScriptPromptDismissedRepoIds:
            validRepoHostIdentities.size === 0
              ? sanitizeSetupScriptPromptDismissals(ui.setupScriptPromptDismissedRepoIds)
              : filterSetupScriptPromptDismissalsToValidRepos(
                  ui.setupScriptPromptDismissedRepoIds,
                  validRepoHostIdentities
                ),
          setupGuideSidebarDismissed: ui.setupGuideSidebarDismissed === true,
          setupGuideBrowserMilestoneMigrated: ui.setupGuideBrowserMilestoneMigrated === true,
          setupGuideBrowserMilestoneLegacyComplete:
            ui.setupGuideBrowserMilestoneLegacyComplete === true,
          browserImportHintHidden: ui.browserImportHintHidden === true,
          mobileEmulatorTabIntroDismissed: ui.mobileEmulatorTabIntroDismissed === true,
          mobileEmulatorAgentSetupDismissed: ui.mobileEmulatorAgentSetupDismissed === true,
          projectOrderManualDefaultNoticeDismissed:
            ui.projectOrderManualDefaultNoticeDismissed === true,
          // Why: treat only explicit true as dismissed so a false from migration still surfaces.
          usagePercentageDisplayChangeNoticeDismissed:
            ui.usagePercentageDisplayChangeNoticeDismissed === true,
          // Why: default false so existing users still see the CTA; only explicit dismissal persists true.
          usageEmptyStateDismissed: ui.usageEmptyStateDismissed === true,
          ...hydrateAgentReadState(ui),
          workspaceCleanupDismissals: sanitizeWorkspaceCleanupDismissals(
            ui.workspaceCleanup?.dismissals
          ),
          // Why the normalizer rather than a cast: this blob is hand-editable and
          // may come from an older or newer build; it degrades field by field
          // instead of bricking the cleanup dialog.
          // Why: a sync broadcast can carry stale browse state while its writer is debounced.
          workspaceCleanupBrowse:
            source === 'startup'
              ? normalizeWorkspaceCleanupBrowseState(ui.workspaceCleanup?.browse)
              : s.workspaceCleanupBrowse,
          // Why: restore only on startup; on 'sync' broadcasts it would clobber the window's current per-window view.
          activeView:
            source === 'startup'
              ? sanitizeHydratedActiveView(ui.activeView, s.settings)
              : s.activeView,
          persistedUIReady: true
        }
        // The incoming payload is authoritative for the writer-owned fields, so it becomes the
        // writer's new diff baseline — but fields with an unflushed local edit (mirror diverged
        // from the previous baseline) keep the local value so a broadcast arriving inside the
        // writer's debounce window can't silently revert what the user just toggled (STA-5781).
        // Order matters: capture the baseline BEFORE overlaying pending edits, or the baseline
        // would equal the pending value, the diff would go empty, and the toggle would be dropped.
        // Note the width sanitizers above fall back to the CURRENT store value only for
        // non-numeric input (numbers are clamped in place), so a captured width can differ
        // from what main holds only for garbage payloads; at worst main keeps an
        // out-of-range width until the next drag re-writes it.
        const nextWriteBaseline = capturePersistedUIWriteBaseline(hydrated)
        const previousBaseline = s.persistedUIWriteBaseline
        if (previousBaseline) {
          const pendingLocalEdits = diffPersistedUIWriteFields(
            capturePersistedUIWriteBaseline(s),
            previousBaseline
          )
          Object.assign(hydrated, pendingLocalEdits)
          // In-flight fields too: a flip-back to the baseline value diffs empty,
          // yet the in-flight write's echo must not revert it (PR#17057 review).
          for (const field of Object.keys(
            s.persistedUIWriteInFlightCounts
          ) as (keyof PersistedUIWriteBaseline)[]) {
            ;(hydrated as Record<string, unknown>)[field] = s[field]
          }
        }
        // Why: return the same ref on identical hydration so App's debounced writer doesn't echo it back to main.
        // The baseline must still advance when it moved (a remote same-field write during an in-flight
        // ack pins the only visibly differing field, and our own echo precedes every ack) — but only
        // the two baseline keys, or every ordinary write's echo would churn the store's collection
        // identities and re-render identity-compared selectors once per write.
        // Why the generation bumps only on baseline movement: an unrelated-field
        // broadcast during an in-flight write would otherwise void that write's
        // fold and cost a redundant trailing re-send of identical values.
        const writeBaselineMoved =
          !previousBaseline ||
          Object.keys(diffPersistedUIWriteFields(nextWriteBaseline, previousBaseline)).length > 0
        const nextWriteBaselineGeneration = writeBaselineMoved
          ? s.persistedUIWriteBaselineGeneration + 1
          : s.persistedUIWriteBaselineGeneration
        if (hydratedUIPartialMatchesState(s, hydrated as Partial<UISlice>)) {
          if (!writeBaselineMoved) {
            return s
          }
          return {
            persistedUIWriteBaseline: nextWriteBaseline,
            persistedUIWriteBaselineGeneration: nextWriteBaselineGeneration
          }
        }
        return {
          ...hydrated,
          persistedUIWriteBaseline: nextWriteBaseline,
          persistedUIWriteBaselineGeneration: nextWriteBaselineGeneration
        } as Partial<AppState>
      })
  }
}
