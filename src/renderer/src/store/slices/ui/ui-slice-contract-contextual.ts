import type { PersistedTrustedOrcaHooks } from '../../../../../shared/orca-yaml-hook-types'
import type {
  FeatureInteractionId,
  FeatureInteractionState
} from '../../../../../shared/feature-interactions'
import type { FeatureTipId } from '../../../../../shared/feature-tips'
import type { ContextualTourId } from '../../../../../shared/contextual-tours'
import type { OrcaHookScriptKind } from '../../../lib/orca-hook-trust'
import type { SettingsNavigationTarget } from '../../../lib/settings-navigation-types'
import type { ExecutionHostId } from '../../../../../shared/execution-host'

export type UISliceContextual = {
  openSettingsPage: () => void
  closeSettingsPage: () => void
  settingsNavigationTarget: SettingsNavigationTarget | null
  openSettingsTarget: (target: NonNullable<UISliceContextual['settingsNavigationTarget']>) => void
  clearSettingsTarget: () => void
  /** Which host the Projects Settings pane shows per project (keyed by projectId). Ephemeral on purpose — never persisted, so reload reopens on the effective host. */
  settingsProjectHostSelection: Record<string, ExecutionHostId>
  settingsProjectSetupSelection: Record<string, string>
  setSettingsProjectHostSelection: (
    projectId: string,
    hostId: ExecutionHostId,
    setupId?: string
  ) => void
  /** One-shot Appearance accordion to expand for nested Settings deep links (e.g. Usage percentages under Window & Sidebar). Cleared when Appearance consumes it. */
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
  modalData: Record<string, unknown>
  openModal: (modal: UISliceContextual['activeModal'], data?: Record<string, unknown>) => void
  closeModal: () => void
  featureTipsSeenIds: FeatureTipId[]
  markFeatureTipsSeen: (ids: FeatureTipId[]) => void
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
  contextualTourShownThisSession: boolean
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
    kind: OrcaHookScriptKind,
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
  usageEmptyStateDismissed: boolean
  dismissUsageEmptyState: () => void
}
