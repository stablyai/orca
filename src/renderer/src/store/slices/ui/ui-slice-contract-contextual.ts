import type { PersistedTrustedOrcaHooks } from '../../../../../shared/workspace-setup/orca-yaml-hook-types'
import type { FeatureInteractionId } from '../../../../../shared/feature-education/interactions/feature-interaction-catalog'
import type { FeatureInteractionState } from '../../../../../shared/feature-education/interactions/feature-interactions'
import type {
  FeatureTipId,
  FeatureTipSeenId
} from '../../../../../shared/feature-education/feature-tips'
import type { ChatUiLaunchTipVariant } from '../../../../../shared/feature-education/chat-ui-launch-tip-audience'
import type { ContextualTourId } from '../../../../../shared/feature-education/contextual-tours/contextual-tours'
import type { OrcaHookTrustKind } from '../../../../../shared/workspace-setup/hooks/orca-hook-trust-entries'
import type { SettingsNavigationTarget } from '../../../components/settings/navigation/settings-navigation-types'
import type { ExecutionHostId } from '../../../../../shared/execution-host/execution-host'
import type { WslMovedProject } from '../../../../../shared/wsl-move/wsl-moved-project'

export type WorktreeCardsIntroChoice = 'new' | 'classic'

export type UISliceContextual = {
  openSettingsPage: () => void
  closeSettingsPage: () => void
  settingsNavigationTarget: SettingsNavigationTarget | null
  openSettingsTarget: (target: NonNullable<UISliceContextual['settingsNavigationTarget']>) => void
  clearSettingsTarget: () => void
  /** Entry keys retain last-pick order so regrouping resolves aliases. Renderer-only; never persisted. */
  settingsProjectHostSelection: Record<string, ExecutionHostId>
  settingsProjectSetupSelection: Record<string, string>
  setSettingsProjectHostSelection: (
    selectionKey: string,
    hostId: ExecutionHostId,
    setupId?: string
  ) => void
  /** One-shot nested Settings accordion deep link; Appearance clears it on consumption. */
  appearanceAccordionDeepLink: 'interface' | 'terminal' | 'window' | null
  setAppearanceAccordionDeepLink: (
    section: NonNullable<UISliceContextual['appearanceAccordionDeepLink']>
  ) => void
  clearAppearanceAccordionDeepLink: () => void
  activeModal:
    | 'none'
    | 'create-worktree'
    | 'edit-meta'
    | 'delete-worktree'
    | 'preserved-branch-review'
    | 'forget-ssh-workspace'
    | 'confirm-add-project-from-folder'
    | 'confirm-non-git-folder'
    | 'confirm-remove-folder'
    | 'confirm-sleep-twin'
    | 'add-repo'
    | 'quick-open'
    | 'worktree-palette'
    | 'workspace-cleanup'
    | 'project-added'
    | 'worktree-visibility'
    | 'setup-guide'
    | 'feature-wall'
    | 'feature-tips'
    | 'new-workspace-composer'
    | 'confirm-orca-yaml-hooks'
    | 'diagram-viewer'
    | 'agent-session-history'
    | 'chat-account-usage'
    | 'node-dist-mirror'
  modalData: Record<string, unknown>
  openModal: (modal: UISliceContextual['activeModal'], data?: Record<string, unknown>) => void
  closeModal: () => void
  featureTipsSeenIds: FeatureTipSeenId[]
  markFeatureTipsSeen: (ids: FeatureTipId[]) => void
  /** Main's once-decided Chat UI launch tip variant; null until read. */
  chatUiLaunchTipVariant: ChatUiLaunchTipVariant | null
  setChatUiLaunchTipVariant: (variant: ChatUiLaunchTipVariant) => void
  featureInteractions: FeatureInteractionState
  recordFeatureInteraction: (id: FeatureInteractionId) => Promise<void>
  contextualToursSeenIds: ContextualTourId[]
  contextualToursAutoEligible: boolean | null
  activeContextualTourId: ContextualTourId | null
  activeContextualTourStepIndex: number
  activeContextualTourSource: string | null
  activeContextualTourSourceDetached: boolean
  activeContextualTourWasFeaturePreviouslyInteracted: boolean
  contextualTourNavigationInteractionSnapshot: Partial<Record<ContextualTourId, boolean>>
  activeContextualTourSuppressed: boolean
  // Tours started this app session. Only one informational tour may start per session; an
  // unfinished action tour started here is paused, not over.
  contextualToursStartedThisSession: ContextualTourId[]
  contextualToursOnboardingVisible: boolean
  contextualToursBlockingSurfaceVisible: boolean
  lastCompletedContextualTourId: ContextualTourId | null
  setContextualToursAutoEligible: (eligible: boolean) => void
  setContextualToursOnboardingVisible: (visible: boolean) => void
  setContextualToursBlockingSurfaceVisible: (visible: boolean) => void
  requestContextualTour: (
    id: ContextualTourId,
    source: string,
    wasFeaturePreviouslyInteracted?: boolean,
    options?: { force?: boolean }
  ) => void
  suppressContextualTour: (id: ContextualTourId, source: string) => void
  detachContextualTourSource: (id: ContextualTourId, source: string) => void
  advanceContextualTour: () => void
  regressContextualTour: () => void
  dismissContextualTour: (id?: ContextualTourId) => void
  completeContextualTour: (id?: ContextualTourId) => void
  cancelContextualTour: (id?: ContextualTourId) => void
  markContextualToursSeen: (ids: ContextualTourId[]) => void
  trustedOrcaHooks: PersistedTrustedOrcaHooks
  markOrcaHookScriptConfirmed: (
    repoId: string,
    kind: OrcaHookTrustKind,
    contentHash: string
  ) => void
  markOrcaHookRepoAlwaysTrusted: (repoId: string) => void
  clearOrcaHookTrustForRepo: (repoId: string) => void
  setupScriptPromptDismissedRepoIds: readonly string[]
  dismissSetupScriptPrompt: (repoHostIdentity: string) => void
  setupGuideSidebarDismissed: boolean
  setSetupGuideSidebarDismissed: (dismissed: boolean) => void
  setupGuideBrowserMilestoneMigrated: boolean
  setupGuideBrowserMilestoneLegacyComplete: boolean
  markSetupGuideBrowserMilestoneMigrated: (legacyComplete: boolean) => void
  browserImportHintHidden: boolean
  setBrowserImportHintHidden: (hidden: boolean) => void
  mobileEmulatorTabIntroDismissed: boolean
  dismissMobileEmulatorTabIntro: () => void
  mobileEmulatorAgentSetupDismissed: boolean
  dismissMobileEmulatorAgentSetup: () => void
  projectOrderManualDefaultNoticeDismissed: boolean
  dismissProjectOrderManualDefaultNotice: () => void
  usagePercentageDisplayChangeNoticeDismissed: boolean
  dismissUsagePercentageDisplayChangeNotice: () => void
  statusBarCompactChangeNoticeDismissed: boolean
  dismissStatusBarCompactChangeNotice: () => void
  usageEmptyStateDismissed: boolean
  dismissUsageEmptyState: () => void
  pluginsAlphaNoticeDismissed: boolean
  dismissPluginsAlphaNotice: () => void
  codexTerminalServerIsolationNoticeSeen: boolean
  markCodexTerminalServerIsolationNoticeSeen: () => void
  codexSharedSettingsNoticeSeen: boolean
  markCodexSharedSettingsNoticeSeen: () => void
  worktreeCardsUpdateNoticeSeen: boolean
  markWorktreeCardsUpdateNoticeSeen: () => void
  worktreeCardsIntroNoticeSeen: boolean
  markWorktreeCardsIntroNoticeSeen: () => void
  /** Open intro note's switch position; 'new' previews the new cards without saving. Not persisted. */
  worktreeCardsIntroChoice: WorktreeCardsIntroChoice | null
  setWorktreeCardsIntroChoice: (choice: WorktreeCardsIntroChoice | null) => void
  /** One-shot pointer at the options button after someone keeps the new cards. Not persisted. */
  worktreeCardsIntroKeptHintOpen: boolean
  setWorktreeCardsIntroKeptHintOpen: (open: boolean) => void
  claudeDiffPanelNoticeSeen: boolean
  markClaudeDiffPanelNoticeSeen: () => void
  wslMovedSectionCollapsed: boolean
  setWslMovedSectionCollapsed: (collapsed: boolean) => void
  /** `wslMovedProjectKey`s of moved-project entries hidden from the sidebar. */
  hiddenWslMovedProjectKeys: readonly string[]
  hideWslMovedProject: (project: Pick<WslMovedProject, 'kind' | 'id' | 'distro'>) => void
  /** Drops hidden keys of projects no longer moved, so a later move lists again. */
  retainHiddenWslMovedProjects: (projects: readonly WslMovedProject[]) => void
}
