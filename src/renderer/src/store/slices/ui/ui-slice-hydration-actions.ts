import { normalizeStatusBarUsageFormat } from '../../../../../shared/status-bar/status-bar-usage-format'
import type { UISlice, UISliceGet, UISliceSet } from './ui-slice-contract'
import type { AppState } from '../../types'
import { normalizeRightSidebarRoute } from '../right-sidebar/right-sidebar-route'
import {
  applyManualRepoOrder,
  normalizeManualRepoOrder
} from '../../../../../shared/repository/manual-repo-order'
import { normalizeWorkspaceCleanupBrowseState } from '../../../../../shared/workspace-cleanup/workspace-cleanup-browse-state'
import { hydrateFeatureInteractions } from './ui-slice-feature-interactions-hydration'
import { normalizeContextualTourIds } from '../../../../../shared/feature-education/contextual-tours/contextual-tours'
import { normalizeFeatureTipIds } from '../../../../../shared/feature-education/feature-tips'
import { normalizeAgentActivityDisplayMode } from '../../../../../shared/agent-status/presentation/agent-activity-display-mode'
import { normalizeWorktreeCardProperties } from '../../../../../shared/worktree/row-display/card-properties'
import {
  clampWorkspaceBoardColumnWidth,
  clampWorkspaceBoardOpacity,
  normalizeWorkspaceStatuses
} from '../../../../../shared/workspace/status/workspace-statuses'
import { PET_SIZE_DEFAULT, PET_SIZE_MAX, PET_SIZE_MIN } from '../../../../../shared/pets/pet-types'
import { clampMarkdownTocPanelWidth } from '../../../../../shared/editor/markdown/markdown-toc-panel-width'
import { clampCombinedDiffFileTreeWidth } from '../../../../../shared/source-control/diff/combined-diff-file-tree-width'
import { normalizeUsagePercentageDisplay } from '../../../../../shared/agent-usage/display/usage-percentage-display'
import { normalizeStatusBarUsageMode } from '../../../../../shared/status-bar/status-bar-usage-mode'
import { normalizeBrowserPageZoomLevel } from '../../../../../shared/browser/site-settings/browser-page-zoom'
import { normalizeKagiSessionLink } from '../../../../../shared/browser/navigation/browser-url'
import { isReleaseChannel } from '../../../../../shared/updater/release-channel'
import {
  filterSetupScriptPromptDismissalsToValidRepos,
  sanitizeSetupScriptPromptDismissals
} from '../../../runtime/repo-hooks/setup-script-prompt'
import { isBundledPetId, DEFAULT_PET_ID } from '../../../components/pet/pet-models'
import { getRepoHostIdentity } from '../../../../../shared/repository/repo-host-identity'
import {
  withWslMovedRepoIds,
  withWslMovedSetupScriptDismissals
} from '../../repos/wsl-moved-repo-ui-retention'

import {
  capturePersistedUIWriteBaseline,
  diffPersistedUIWriteFields,
  PERSISTED_UI_WRITE_BASELINE_FIELDS
} from './persisted-ui-write-baseline'
import {
  hydrateTrustedOrcaHooks,
  hydrateUnexpectedSignoutDismissal,
  sanitizeHydratedActiveView,
  sanitizePersistedRepoIds,
  sanitizeWorkspaceCleanupDismissals,
  sanitizePersistedSidebarWidth,
  keepUnchangedHydratedFields,
  hydratedFieldsAreState,
  clampPetSize
} from './ui-slice-hydration-sanitizers'
import {
  hydrateOneShotNoticesSeen,
  hydrateReadAndBotState,
  sanitizeTaskResumeState
} from './ui-slice-bot-sidebar-hydration'
import { hydrateWslMovedSection } from './ui-slice-wsl-moved-section-actions'
import { hydrateBrowserPaneLayout } from './browser-pane-layout-hydration'
import { hydrateStatusBarItems } from './ui-slice-hydration-status-bar-items'
import { sanitizeActivityBarArrangement } from './ui-slice-hydration-activity-bar'
import { hydrateWorkspaceFilters } from './ui-slice-hydration-workspace-filters'
import { isWebClientLocation } from '@/app-shell/platform/web-client-location'
import { hydrateChatReadMarks } from './hydrate-chat-read-marks'

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
        const web = isWebClientLocation()
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
          ...sanitizeActivityBarArrangement(ui, s),
          groupBy: (ui.groupBy as UISlice['groupBy'] | 'parent') === 'parent' ? 'repo' : ui.groupBy,
          sortBy,
          // Why: main-process getUI() already normalized this (defaulting to 'manual'); read it through without migrating.
          projectOrderBy: ui.projectOrderBy,
          // Why: Active-only was retired; force the old flag off so an old profile can't invisibly narrow the workspace list.
          showActiveOnly: false,
          ...hydrateWorkspaceFilters(
            ui,
            s,
            validRepoIds,
            { persistedFilterRepoIds, persistedAgentsFilterRepoIds },
            manualRepoOrder,
            orderedRepos
          ),
          collapsedGroups: new Set(ui.collapsedGroups ?? []),
          uiZoomLevel: ui.uiZoomLevel ?? 0,
          editorFontZoomLevel: ui.editorFontZoomLevel ?? 0,
          worktreeCardProperties: normalizeWorktreeCardProperties(ui.worktreeCardProperties),
          _worktreeCardModeDefaulted: ui._worktreeCardModeDefaulted === true,
          showAgentModels: ui.showAgentModels !== false,
          agentActivityDisplayMode: normalizeAgentActivityDisplayMode(ui.agentActivityDisplayMode),
          workspaceStatuses: normalizeWorkspaceStatuses(ui.workspaceStatuses),
          workspaceBoardOpacity: clampWorkspaceBoardOpacity(ui.workspaceBoardOpacity),
          workspaceBoardColumnWidth: clampWorkspaceBoardColumnWidth(ui.workspaceBoardColumnWidth),
          syncTaskStatusFromWorkspaceBoard: ui.syncTaskStatusFromWorkspaceBoard === true,
          statusBarItems: statusBarItemsWithGrok,
          statusBarVisible: ui.statusBarVisible ?? true,
          usagePercentageDisplay: normalizeUsagePercentageDisplay(ui.usagePercentageDisplay),
          statusBarUsageMode: normalizeStatusBarUsageMode(ui.statusBarUsageMode),
          statusBarUsageFormat: normalizeStatusBarUsageFormat(ui.statusBarUsageFormat),
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
          seenMacosUpdateRequirement: ui.seenMacosUpdateRequirement ?? null,
          osc52ClipboardDefaultOnNoticePending: ui.osc52ClipboardDefaultOnNoticePending === true,
          browserDefaultUrl: ui.browserDefaultUrl ?? null,
          browserDefaultSearchEngine: ui.browserDefaultSearchEngine ?? null,
          browserDefaultZoomLevel: normalizeBrowserPageZoomLevel(ui.browserDefaultZoomLevel),
          browserKagiSessionLink: normalizeKagiSessionLink(ui.browserKagiSessionLink ?? ''),
          ...hydrateBrowserPaneLayout(ui),
          taskResumeState: sanitizeTaskResumeState(ui.taskResumeState),
          featureTipsSeenIds: normalizeFeatureTipIds(ui.featureTipsSeenIds),
          ...hydrateFeatureInteractions(s.workspaceBoardUsedBeforeLaunch, ui),
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
          ...hydrateOneShotNoticesSeen(ui),
          ...hydrateWslMovedSection(ui),
          ...hydrateReadAndBotState(ui),
          workspaceCleanupDismissals: sanitizeWorkspaceCleanupDismissals(
            ui.workspaceCleanup?.dismissals
          ),
          // Normalize hand-editable mixed-version cleanup state fieldwise; sync broadcasts must preserve locally debounced browse edits.
          workspaceCleanupBrowse:
            source !== 'sync'
              ? normalizeWorkspaceCleanupBrowseState(ui.workspaceCleanup?.browse)
              : s.workspaceCleanupBrowse,
          // Why: restore only on startup; on 'sync' broadcasts it would clobber the window's current per-window view.
          activeView: source === 'sync' ? s.activeView : sanitizeHydratedActiveView(ui.activeView),
          persistedUIReady: true
        }
        keepUnchangedHydratedFields(s, hydrated as Partial<UISlice>)
        // Capture authoritative baseline before overlaying dirty/in-flight local fields or their diff vanishes (STA-5781). Nonnumeric width fallback may differ from main until the next drag.
        const authoritative = capturePersistedUIWriteBaseline(hydrated)
        const previousBaseline = s.persistedUIWriteBaseline
        const pending = previousBaseline
          ? diffPersistedUIWriteFields(capturePersistedUIWriteBaseline(s), previousBaseline)
          : {}
        const { baseline: nextWriteBaseline, localMarks } = hydrateChatReadMarks(
          s,
          authoritative,
          pending,
          web
        )
        hydrated.acknowledgedAgentsByPaneKey = nextWriteBaseline.acknowledgedAgentsByPaneKey
        hydrated.activityClearedAtByPaneKey = nextWriteBaseline.activityClearedAtByPaneKey
        hydrated.manuallyUnreadTurnsByPaneKey = nextWriteBaseline.manuallyUnreadTurnsByPaneKey
        Object.assign(hydrated, pending, localMarks)
        // In-flight fields too: a flip-back to the baseline value diffs empty.
        for (const field of PERSISTED_UI_WRITE_BASELINE_FIELDS) {
          if (s.persistedUIWriteInFlightCounts[field]) {
            Object.assign(hydrated, { [field]: s[field] })
          }
        }
        // Identical hydration preserves root identity; advance only baseline keys on baseline movement so acks cannot erase remote edits or spur redundant resends.
        const writeBaselineMoved =
          !previousBaseline ||
          Object.keys(diffPersistedUIWriteFields(nextWriteBaseline, previousBaseline)).length > 0
        const nextWriteBaselineGeneration = writeBaselineMoved
          ? s.persistedUIWriteBaselineGeneration + 1
          : s.persistedUIWriteBaselineGeneration
        if (hydratedFieldsAreState(s, hydrated as Partial<UISlice>)) {
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
