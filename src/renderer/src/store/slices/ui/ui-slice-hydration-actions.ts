import type { UISlice, UISliceGet, UISliceSet } from './ui-slice-contract'
import type { AppState } from '../../types'
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
  normalizeActivityGroupBy,
  normalizeThreadReadFilter
} from '../../../../../shared/agents-view-thread-filters'
import {
  clampWorkspaceBoardColumnWidth,
  clampWorkspaceBoardOpacity,
  normalizeWorkspaceStatuses
} from '../../../../../shared/workspace-statuses'
import { PET_SIZE_DEFAULT, PET_SIZE_MAX, PET_SIZE_MIN } from '../../../../../shared/pet-types'
import { clampMarkdownTocPanelWidth } from '../../../../../shared/markdown-toc-panel-width'
import { normalizeBrowserDevToolsDockLayout } from '../../../../../shared/browser-devtools-dock'
import { clampCombinedDiffFileTreeWidth } from '../../../../../shared/combined-diff-file-tree-width'
import { parsePersistedAutomationHostFilter } from '../../../../../shared/automation-host-filter'
import { normalizeUsagePercentageDisplay } from '../../../../../shared/usage-percentage-display'
import { normalizeStatusBarUsageMode } from '../../../../../shared/status-bar-usage-mode'
import { normalizeBrowserPageZoomLevel } from '../../../../../shared/browser-page-zoom'
import { normalizeKagiSessionLink } from '../../../../../shared/browser-url'
import { isReleaseChannel } from '../../../../../shared/release-channel'
import {
  filterSetupScriptPromptDismissalsToValidRepos,
  sanitizeSetupScriptPromptDismissals
} from '../../../lib/setup-script-prompt'
import { isBundledPetId, DEFAULT_PET_ID } from '../../../components/pet/pet-models'
import { getRepoHostIdentity } from '../repo-host-identity'
import {
  withWslMovedRepoIds,
  withWslMovedSetupScriptDismissals
} from '../../repos/wsl-moved-repo-ui-retention'
import type { PersistedUIWriteBaseline } from '../persisted-ui-write-baseline'
import {
  capturePersistedUIWriteBaseline,
  diffPersistedUIWriteFields
} from '../persisted-ui-write-baseline'
import {
  hydrateTrustedOrcaHooks,
  hydrateUnexpectedSignoutDismissal,
  normalizeHydratedVisibleWorkspaceHostIds,
  preserveStringArrayIdentity,
  sanitizeHydratedActiveView,
  sanitizePersistedRepoIds,
  sanitizeExplorerPreferences,
  sanitizeWorkspaceCleanupDismissals,
  sanitizePersistedSidebarWidth,
  hydratedUIPartialMatchesState,
  clampPetSize
} from './ui-slice-hydration-sanitizers'
import { hydrateAgentReadState, sanitizeTaskResumeState } from './ui-slice-hydration-values'
import { hydrateStatusBarItems } from './ui-slice-hydration-status-bar-items'

const MAX_LEFT_SIDEBAR_WIDTH = 500
const MAX_RIGHT_SIDEBAR_WIDTH = 4000
/** Builds hydration actions that reconcile authoritative UI state without discarding pending local edits. */
export function createUiHydrationActions(set: UISliceSet, _get: UISliceGet): Partial<UISlice> {
  return {
    /** Captures the incoming write baseline before overlaying dirty or in-flight local fields. */
    hydratePersistedUI: (ui, source = 'sync') =>
      set((s) => {
        const manualRepoOrder = normalizeManualRepoOrder(ui.manualRepoOrder)
        const orderedRepos = applyManualRepoOrder(s.repos, manualRepoOrder)
        const listedRepoIds = new Set(s.repos.map((repo) => repo.id))
        // An empty catalog keeps everything; otherwise a moved repo whose host has not loaded stays.
        const validRepoIds =
          listedRepoIds.size === 0
            ? listedRepoIds
            : withWslMovedRepoIds(listedRepoIds, s.wslMovedProjects)
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
          sidebarOpen: typeof ui.sidebarOpen === 'boolean' ? ui.sidebarOpen : true,
          rightSidebarOpen: typeof ui.rightSidebarOpen === 'boolean' ? ui.rightSidebarOpen : true,
          ...normalizeRightSidebarRoute(ui.rightSidebarTab, ui.rightSidebarExplorerView),
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
          ...sanitizeExplorerPreferences(ui),
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
          agentsHideWorkspacesFromOtherDevices: ui.agentsHideWorkspacesFromOtherDevices === true,
          agentsHideAutomationGeneratedWorkspaces:
            ui.agentsHideAutomationGeneratedWorkspaces === true,
          agentsHideCliCreatedWorkspaces: ui.agentsHideCliCreatedWorkspaces === true,
          agentsShowChildAgents: ui.agentsShowChildAgents === true,
          agentsCompactMode: ui.agentsCompactMode !== false,
          agentsShowSearch: ui.agentsShowSearch !== false,
          agentsReadFilter: normalizeThreadReadFilter(ui.agentsReadFilter),
          agentsGroupBy: normalizeActivityGroupBy(ui.agentsGroupBy),
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
          ...hydrateUnexpectedSignoutDismissal(s, ui.dismissedUnexpectedSignoutVersion),
          // Reject channels unknown to this build; activeChannel falls back only on null, otherwise leaking invalid values to listBuilds/controls.
          releaseChannelOverride: isReleaseChannel(ui.releaseChannelOverride)
            ? ui.releaseChannelOverride
            : null,
          updateReassuranceSeen: ui.updateReassuranceSeen ?? false,
          osc52ClipboardDefaultOnNoticePending: ui.osc52ClipboardDefaultOnNoticePending === true,
          browserDefaultUrl: ui.browserDefaultUrl ?? null,
          browserDefaultSearchEngine: ui.browserDefaultSearchEngine ?? null,
          browserDefaultZoomLevel: normalizeBrowserPageZoomLevel(ui.browserDefaultZoomLevel),
          browserKagiSessionLink: normalizeKagiSessionLink(ui.browserKagiSessionLink ?? ''),
          browserDevToolsDock: normalizeBrowserDevToolsDockLayout(ui.browserDevToolsDock),
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
              : withWslMovedSetupScriptDismissals(
                  ui.setupScriptPromptDismissedRepoIds,
                  filterSetupScriptPromptDismissalsToValidRepos(
                    ui.setupScriptPromptDismissedRepoIds,
                    validRepoHostIdentities
                  ),
                  s.wslMovedProjects
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
          statusBarCompactChangeNoticeDismissed: ui.statusBarCompactChangeNoticeDismissed !== false,
          // Why: default false so existing users still see the CTA; only explicit dismissal persists true.
          usageEmptyStateDismissed: ui.usageEmptyStateDismissed === true,
          pluginsAlphaNoticeDismissed: ui.pluginsAlphaNoticeDismissed === true,
          codexTerminalServerIsolationNoticeSeen:
            ui.codexTerminalServerIsolationNoticeSeen === true,
          codexSharedSettingsNoticeSeen: ui.codexSharedSettingsNoticeSeen === true,
          claudeDiffPanelNoticeSeen: ui.claudeDiffPanelNoticeSeen === true,
          ...hydrateAgentReadState(ui),
          workspaceCleanupDismissals: sanitizeWorkspaceCleanupDismissals(
            ui.workspaceCleanup?.dismissals
          ),
          // Normalize hand-editable mixed-version cleanup state fieldwise; sync broadcasts must preserve locally debounced browse edits.
          workspaceCleanupBrowse:
            source === 'startup'
              ? normalizeWorkspaceCleanupBrowseState(ui.workspaceCleanup?.browse)
              : s.workspaceCleanupBrowse,
          // Why: restore only on startup; on 'sync' broadcasts it would clobber the window's current per-window view.
          activeView:
            source === 'startup' ? sanitizeHydratedActiveView(ui.activeView) : s.activeView,
          persistedUIReady: true
        }
        // Capture authoritative baseline before overlaying dirty/in-flight local fields or their diff vanishes (STA-5781). Nonnumeric width fallback may differ from main until the next drag.
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
        // Identical hydration preserves root identity; advance only baseline keys on baseline movement so acks cannot erase remote edits or spur redundant resends.
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
