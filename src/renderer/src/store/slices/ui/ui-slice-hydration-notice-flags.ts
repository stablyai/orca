import type { PersistedUIState } from '../../../../../shared/persisted-ui-state-types'

/** One-shot guide, hint, and notice flags, each defaulting to unseen unless noted. */
export function hydrateDismissedNoticeFlags(ui: PersistedUIState) {
  return {
    setupGuideSidebarDismissed: ui.setupGuideSidebarDismissed === true,
    setupGuideBrowserMilestoneMigrated: ui.setupGuideBrowserMilestoneMigrated === true,
    setupGuideBrowserMilestoneLegacyComplete: ui.setupGuideBrowserMilestoneLegacyComplete === true,
    browserImportHintHidden: ui.browserImportHintHidden === true,
    mobileEmulatorTabIntroDismissed: ui.mobileEmulatorTabIntroDismissed === true,
    mobileEmulatorAgentSetupDismissed: ui.mobileEmulatorAgentSetupDismissed === true,
    cloudAgentSetupDone: ui.cloudAgentSetupDone === true,
    projectOrderManualDefaultNoticeDismissed: ui.projectOrderManualDefaultNoticeDismissed === true,
    // Why: treat only explicit true as dismissed so a false from migration still surfaces.
    usagePercentageDisplayChangeNoticeDismissed:
      ui.usagePercentageDisplayChangeNoticeDismissed === true,
    statusBarCompactChangeNoticeDismissed: ui.statusBarCompactChangeNoticeDismissed !== false,
    // Why: default false so existing users still see the CTA; only explicit dismissal persists true.
    usageEmptyStateDismissed: ui.usageEmptyStateDismissed === true,
    pluginsAlphaNoticeDismissed: ui.pluginsAlphaNoticeDismissed === true,
    codexTerminalServerIsolationNoticeSeen: ui.codexTerminalServerIsolationNoticeSeen === true,
    codexSharedSettingsNoticeSeen: ui.codexSharedSettingsNoticeSeen === true,
    worktreeCardsUpdateNoticeSeen: ui.worktreeCardsUpdateNoticeSeen === true,
    claudeDiffPanelNoticeSeen: ui.claudeDiffPanelNoticeSeen === true
  }
}
