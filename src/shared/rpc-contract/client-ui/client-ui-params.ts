import { GitHistoryRefName } from '../source-control/git-params'
import * as z from 'zod'
import { StatusBarItems } from './client-ui-status-bar-params'
import { isFeatureTipSeenId } from '../../feature-education/feature-tips'
import {
  WORKTREE_CARD_PROPERTIES,
  normalizeWorktreeCardProperties
} from '../../worktree/row-display/card-properties'
import { isPluginPanelTabKey } from '../../plugins/frames/plugin-tab-key'
import {
  STATIC_RIGHT_SIDEBAR_TABS,
  type StaticRightSidebarTab
} from '../../ui-chrome/ui-chrome-types'
import { isFeatureInteractionId } from '../../feature-education/interactions/feature-interactions'
import type { FeatureInteractionId } from '../../feature-education/interactions/feature-interaction-catalog'
import {
  ACTIVITY_GROUP_BY_VALUES,
  THREAD_READ_FILTER_VALUES
} from '../../agent-status/presentation/agents-view-thread-filters'
import { isReleaseChannel, type ReleaseChannel } from '../../updater/release-channel'
import { ClientUiWorkspaceFilterFields } from './client-ui-workspace-filter-fields-params'
import { TaskResumeState } from './task-resume-state-params'
import { WorkspaceCleanup } from '../workspace-cleanup/workspace-cleanup-ui-params'
import { omitUndefinedValues, tolerateUnknownValues } from './ui-update-value-tolerance-params'

export const NullableString = z.string().nullable()

export const StringArray = z.array(z.string())

export const FeatureTipIds = z.array(
  z.custom(isFeatureTipSeenId, { message: 'Unknown feature tip id' })
)

export const UnknownRecord = z.record(z.string(), z.unknown())

export const UnknownRecordArray = z.array(UnknownRecord)

// Derive from the shared union; drift previously omitted cli and rejected whole client payloads.
export const WorktreeCardPropertyParam = z.enum(WORKTREE_CARD_PROPERTIES)

export const WorktreeCardProperties = z
  .array(WorktreeCardPropertyParam)
  .transform((value) => normalizeWorktreeCardProperties(value))

// Plugin panels are open-ended `plugin:<publisher>.<id>/<panel>` keys, so the
// schema validates their shape rather than enumerating them.
export const RightSidebarTabParam = z.custom<StaticRightSidebarTab | `plugin:${string}`>(
  (value) =>
    typeof value === 'string' &&
    (STATIC_RIGHT_SIDEBAR_TABS.includes(value as StaticRightSidebarTab) ||
      isPluginPanelTabKey(value)),
  { message: 'Unknown right sidebar tab' }
)

export const AgentActivityDisplayMode = z.enum(['compact', 'full'])

export const WorkspaceStatusDefinition = z.object({
  id: z.string(),
  label: z.string(),
  color: z.string().optional(),
  icon: z.string().optional()
})

export const FeatureInteractionRecord = z
  .object({
    firstInteractedAt: z.number().finite().nonnegative(),
    interactionCount: z.number().int().positive().optional()
  })
  .strict()

export const FeatureInteractions = z
  .record(z.string(), FeatureInteractionRecord)
  .superRefine((value, ctx) => {
    for (const id of Object.keys(value)) {
      if (!isFeatureInteractionId(id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Unknown feature interaction id: ${id}`,
          path: [id]
        })
      }
    }
  })

export const FeatureInteractionIdParam = z.custom<FeatureInteractionId>(isFeatureInteractionId, {
  message: 'Unknown feature interaction id'
})

export const TopLevelViewSchema = z
  .enum([
    'terminal',
    'settings',
    'tasks',
    'activity',
    'automations',
    'space',
    'skills',
    // Bot templates was a view before it became a dialog; an older peer can still send it.
    'botTemplates',
    'artifacts',
    'mobile'
  ])
  .transform((view) => (view === 'botTemplates' ? 'terminal' : view))

export const UiUpdateFields = z
  .object({
    lastActiveRepoId: NullableString.optional(),
    lastActiveWorktreeId: NullableString.optional(),
    // Why: sync hydration ignores this persisted startup view, so paired windows stay put.
    activeView: TopLevelViewSchema.optional(),
    sidebarWidth: z.number().finite().optional(),
    sidebarOpen: z.boolean().optional(),
    rightSidebarOpen: z.boolean().optional(),
    rightSidebarTab: RightSidebarTabParam.optional(),
    rightSidebarExplorerView: z.enum(['files', 'search']).optional(),
    rightSidebarWidth: z.number().finite().optional(),
    activityBarPosition: z.enum(['top', 'side']).optional(),
    activityBarOrder: z.array(z.string()).optional(),
    activityBarBotOrder: z.array(z.string()).optional(),
    activityBarHidden: z.array(z.string()).optional(),
    markdownTocPanelWidth: z.number().finite().optional(),
    combinedDiffFileTreeWidth: z.number().finite().optional(),
    groupBy: z.enum(['none', 'workspace-status', 'repo', 'pr-status']).optional(),
    showWorkspaceLineage: z.boolean().optional(),
    sortBy: z.enum(['name', 'smart', 'recent', 'repo', 'manual']).optional(),
    projectOrderBy: z.enum(['manual', 'recent']).optional(),
    showActiveOnly: z.boolean().optional(),
    hideSleepingWorkspaces: z.boolean().optional(),
    showSleepingWorkspaces: z.boolean().optional(),
    showInactiveWorkspaces: z.boolean().optional(),
    workspaceHostScope: z.string().optional(),
    visibleWorkspaceHostIds: z.array(z.string()).nullable().optional(),
    agentsVisibleHostIds: z.array(z.string()).nullable().optional(),
    agentsFilterRepoIds: StringArray.optional(),
    agentsHideWorkspacesFromOtherDevices: z.boolean().optional(),
    agentsHideAutomationGeneratedWorkspaces: z.boolean().optional(),
    agentsHideCliCreatedWorkspaces: z.boolean().optional(),
    hideBotCreatedWorkspaces: z.boolean().optional(),
    botSidebarView: z
      .object({
        sortBy: z.enum(['manual', 'smart', 'recent', 'name']),
        hidePausedBots: z.boolean(),
        hideSleepingWorkers: z.boolean()
      })
      .optional(),
    botChatFolds: z.record(z.string(), z.enum(['open', 'folded'])).optional(),
    agentsShowChildAgents: z.boolean().optional(),
    agentsCompactMode: z.boolean().optional(),
    agentsShowSearch: z.boolean().optional(),
    agentsReadFilter: z.enum(THREAD_READ_FILTER_VALUES).optional(),
    agentsGroupBy: z.enum(ACTIVITY_GROUP_BY_VALUES).optional(),
    workspaceHostOrder: z.array(z.string()).optional(),
    automationHostFilter: z
      .union([
        z.object({ kind: z.literal('all') }).strict(),
        z.object({ kind: z.literal('host'), hostKey: z.string().min(1) }).strict()
      ])
      .optional(),
    manualRepoOrder: z
      .array(z.object({ hostId: z.string(), repoId: z.string() }).strict())
      .optional(),
    ...ClientUiWorkspaceFilterFields,
    // Part of App.tsx’s debounced writer; missing fields reject the whole paired-client payload.
    explorerDisplayRootByWorktree: z.record(z.string(), z.string()).optional(),
    gitGraphFiltersByWorktree: z
      .record(
        z.string(),
        z.union([z.literal('head'), z.literal('all'), z.array(GitHistoryRefName).max(1000)])
      )
      .optional(),
    showDotfilesByWorktree: z.record(z.string(), z.boolean()).optional(),
    notificationsMutedByWorktree: z.record(z.string(), z.boolean()).optional(),
    collapsedGroups: StringArray.optional(),
    uiZoomLevel: z.number().finite().optional(),
    sidebarZoomLevel: z.number().finite().optional(),
    editorFontZoomLevel: z.number().finite().optional(),
    worktreeCardProperties: WorktreeCardProperties.optional(),
    _worktreeCardModeDefaulted: z.boolean().optional(),
    showAgentModels: z.boolean().optional(),
    agentActivityDisplayMode: AgentActivityDisplayMode.optional(),
    workspaceStatuses: z.array(WorkspaceStatusDefinition).optional(),
    workspaceBoardOpacity: z.number().finite().optional(),
    workspaceBoardColumnWidth: z.number().finite().optional(),
    sidebarBotsHeight: z.number().finite().nullable().optional(),
    sidebarProjectsFirst: z.boolean().optional(),
    syncTaskStatusFromWorkspaceBoard: z.boolean().optional(),
    _workspaceStatusesDefaultOrderMigrated: z.boolean().optional(),
    _workspaceStatusesReorderedDefaultRepaired: z.boolean().optional(),
    _workspaceStatusesDefaultWorkflowMigrated: z.boolean().optional(),
    _workspaceStatusesDefaultVisualsMigrated: z.boolean().optional(),
    statusBarItems: StatusBarItems.optional(),
    _portsStatusBarDefaultAdded: z.boolean().optional(),
    _kimiStatusBarDefaultAdded: z.boolean().optional(),
    _minimaxStatusBarDefaultAdded: z.boolean().optional(),
    _antigravityStatusBarDefaultAdded: z.boolean().optional(),
    _grokStatusBarDefaultAdded: z.boolean().optional(),
    _cursorStatusBarDefaultAdded: z.boolean().optional(),
    _zcodeStatusBarDefaultAdded: z.boolean().optional(),
    _museStatusBarDefaultAdded: z.boolean().optional(),
    _gitBlameStatusBarDefaultAdded: z.boolean().optional(),
    statusBarVisible: z.boolean().optional(),
    usagePercentageDisplay: z.enum(['used', 'remaining']).optional(),
    statusBarUsageMode: z.enum(['verbose', 'compact']).optional(),
    statusBarUsageFormat: z
      .object({
        template: z.string(),
        byProvider: z
          .object({
            claude: z.string().optional(),
            codex: z.string().optional(),
            'opencode-go': z.string().optional(),
            kimi: z.string().optional(),
            minimax: z.string().optional(),
            grok: z.string().optional(),
            antigravity: z.string().optional(),
            cursor: z.string().optional(),
            zcode: z.string().optional(),
            muse: z.string().optional()
          })
          .optional()
      })
      .optional(),
    dismissedUpdateVersion: NullableString.optional(),
    dismissedUnexpectedSignoutVersion: NullableString.optional(),
    lastUpdateCheckAt: z.number().finite().nullable().optional(),
    pendingUpdateNudgeId: NullableString.optional(),
    dismissedUpdateNudgeId: NullableString.optional(),
    // Share the release-channel predicate so new channel overrides cannot silently fail parsing.
    releaseChannelOverride: z.custom<ReleaseChannel>(isReleaseChannel).nullable().optional(),
    notificationPermissionRequested: z.boolean().optional(),
    updateReassuranceSeen: z.boolean().optional(),
    seenMacosUpdateRequirement: NullableString.optional(),
    osc52ClipboardDefaultOnNoticePending: z.boolean().optional(),
    acknowledgedAgentsByPaneKey: z.record(z.string(), z.number().finite()).optional(),
    activityClearedAtByPaneKey: z.record(z.string(), z.number().finite()).optional(),
    manuallyUnreadTurnsByPaneKey: z.record(z.string(), z.number().finite()).optional(),
    browserDefaultUrl: NullableString.optional(),
    browserDefaultSearchEngine: z
      .enum(['google', 'duckduckgo', 'bing', 'kagi'])
      .nullable()
      .optional(),
    browserDefaultZoomLevel: z.number().finite().optional(),
    browserKagiSessionLink: NullableString.optional(),
    browserDevToolsDock: z
      .object({
        side: z.enum(['bottom', 'right']),
        bottomFraction: z.number().finite(),
        rightFraction: z.number().finite()
      })
      .optional(),
    browserExtensionSidePanelWidth: z.number().finite().optional(),
    windowBounds: z
      .object({
        x: z.number().finite(),
        y: z.number().finite(),
        width: z.number().finite(),
        height: z.number().finite()
      })
      .nullable()
      .optional(),
    windowMaximized: z.boolean().optional(),
    _sortBySmartMigrated: z.boolean().optional(),
    _inlineAgentsDefaultedForExperiment: z.boolean().optional(),
    _inlineAgentsDefaultedForAllUsers: z.boolean().optional(),
    trustedOrcaHooks: z.record(z.string(), z.unknown()).optional(),
    setupScriptPromptDismissedRepoIds: StringArray.optional(),
    // Declare renderer one-shot dismissals to avoid whole-payload rejections for paired clients.
    setupGuideSidebarDismissed: z.boolean().optional(),
    setupGuideBrowserMilestoneMigrated: z.boolean().optional(),
    setupGuideBrowserMilestoneLegacyComplete: z.boolean().optional(),
    browserImportHintHidden: z.boolean().optional(),
    mobileEmulatorTabIntroDismissed: z.boolean().optional(),
    mobileEmulatorAgentSetupDismissed: z.boolean().optional(),
    projectOrderManualDefaultNoticeDismissed: z.boolean().optional(),
    usagePercentageDisplayChangeNoticeDismissed: z.boolean().optional(),
    statusBarCompactChangeNoticeDismissed: z.boolean().optional(),
    usageEmptyStateDismissed: z.boolean().optional(),
    pluginsAlphaNoticeDismissed: z.boolean().optional(),
    codexTerminalServerIsolationNoticeSeen: z.boolean().optional(),
    codexSharedSettingsNoticeSeen: z.boolean().optional(),
    worktreeCardsUpdateNoticeSeen: z.boolean().optional(),
    worktreeCardsIntroNoticeSeen: z.boolean().optional(),
    speechModelUpdateNoticeSeen: z.boolean().optional(),
    claudeDiffPanelNoticeSeen: z.boolean().optional(),
    claudeAccountSignInNoticeSeen: z.boolean().optional(),
    petVisible: z.boolean().optional(),
    petId: z.string().optional(),
    customPets: UnknownRecordArray.optional(),
    petSize: z.number().finite().optional(),
    sidekickVisible: z.boolean().optional(),
    sidekickId: z.string().optional(),
    customSidekicks: UnknownRecordArray.optional(),
    sidekickSize: z.number().finite().optional(),
    taskResumeState: TaskResumeState.optional(),
    workspaceCleanup: WorkspaceCleanup.optional(),
    featureTipsSeenIds: FeatureTipIds.optional(),
    featureInteractions: FeatureInteractions.optional(),
    contextualToursSeenIds: StringArray.optional(),
    contextualToursAutoEligible: z.boolean().optional()
  })
  .strict()

export const UiUpdate = z
  .object(tolerateUnknownValues(UiUpdateFields.shape))
  .strict()
  .default({})
  .transform(omitUndefinedValues)
