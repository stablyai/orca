import type { UISlice, UISliceGet, UISliceSet } from './ui-slice-contract'
import { getSetupScriptPromptDismissalKey } from '../../../lib/setup-script-prompt'
import {
  withOrcaHookRepoAlwaysTrusted,
  withOrcaHookScriptConfirmed
} from '../../../../../shared/orca-hook-trust-entries'

export function createUiTrustActions(set: UISliceSet, _get: UISliceGet): Partial<UISlice> {
  return {
    trustedOrcaHooks: {},
    markOrcaHookScriptConfirmed: (repoId, kind, contentHash) =>
      set((s) => {
        const next = withOrcaHookScriptConfirmed(s.trustedOrcaHooks, repoId, kind, contentHash)
        if (next === s.trustedOrcaHooks) {
          return s
        }
        window.api.ui.set({ trustedOrcaHooks: next }).catch(console.error)
        return { trustedOrcaHooks: next }
      }),
    markOrcaHookRepoAlwaysTrusted: (repoId) =>
      set((s) => {
        const next = withOrcaHookRepoAlwaysTrusted(s.trustedOrcaHooks, repoId)
        if (next === s.trustedOrcaHooks) {
          return s
        }
        window.api.ui.set({ trustedOrcaHooks: next }).catch(console.error)
        return { trustedOrcaHooks: next }
      }),
    clearOrcaHookTrustForRepo: (repoId) =>
      set((s) => {
        if (!(repoId in s.trustedOrcaHooks)) {
          return s
        }
        const next = { ...s.trustedOrcaHooks }
        delete next[repoId]
        window.api.ui.set({ trustedOrcaHooks: next }).catch(console.error)
        return { trustedOrcaHooks: next }
      }),
    setupScriptPromptDismissedRepoIds: [],
    dismissSetupScriptPrompt: (repoHostIdentity) =>
      set((s) => {
        const dismissalKey = getSetupScriptPromptDismissalKey(repoHostIdentity)
        if (!repoHostIdentity || s.setupScriptPromptDismissedRepoIds.includes(dismissalKey)) {
          return s
        }
        const next = [...s.setupScriptPromptDismissedRepoIds, dismissalKey]
        window.api.ui.set({ setupScriptPromptDismissedRepoIds: next }).catch(console.error)
        return { setupScriptPromptDismissedRepoIds: next }
      }),
    setupGuideSidebarDismissed: false,
    setSetupGuideSidebarDismissed: (dismissed) =>
      set((s) => {
        if (s.setupGuideSidebarDismissed === dismissed) {
          return s
        }
        window.api.ui.set({ setupGuideSidebarDismissed: dismissed }).catch(console.error)
        return { setupGuideSidebarDismissed: dismissed }
      }),
    setupGuideBrowserMilestoneMigrated: true,
    setupGuideBrowserMilestoneLegacyComplete: false,
    markSetupGuideBrowserMilestoneMigrated: (legacyComplete) =>
      set((s) => {
        if (
          s.setupGuideBrowserMilestoneMigrated &&
          s.setupGuideBrowserMilestoneLegacyComplete === legacyComplete
        ) {
          return s
        }
        const updates = {
          setupGuideBrowserMilestoneMigrated: true,
          setupGuideBrowserMilestoneLegacyComplete: legacyComplete
        }
        window.api.ui.set(updates).catch(console.error)
        return updates
      }),
    browserImportHintHidden: false,
    setBrowserImportHintHidden: (hidden) =>
      set((s) => {
        if (s.browserImportHintHidden === hidden) {
          return s
        }
        window.api.ui.set({ browserImportHintHidden: hidden }).catch(console.error)
        return { browserImportHintHidden: hidden }
      }),
    mobileEmulatorTabIntroDismissed: false,
    dismissMobileEmulatorTabIntro: () =>
      set((s) => {
        if (s.mobileEmulatorTabIntroDismissed) {
          return s
        }
        window.api.ui.set({ mobileEmulatorTabIntroDismissed: true }).catch(console.error)
        return { mobileEmulatorTabIntroDismissed: true }
      }),
    mobileEmulatorAgentSetupDismissed: false,
    dismissMobileEmulatorAgentSetup: () =>
      set((s) => {
        if (s.mobileEmulatorAgentSetupDismissed) {
          return s
        }
        window.api.ui.set({ mobileEmulatorAgentSetupDismissed: true }).catch(console.error)
        return { mobileEmulatorAgentSetupDismissed: true }
      }),
    projectOrderManualDefaultNoticeDismissed: true,
    dismissProjectOrderManualDefaultNotice: () =>
      set((s) => {
        if (s.projectOrderManualDefaultNoticeDismissed) {
          return s
        }
        window.api.ui.set({ projectOrderManualDefaultNoticeDismissed: true }).catch(console.error)
        return { projectOrderManualDefaultNoticeDismissed: true }
      }),
    // Why: default true so pre-hydration / new sessions never flash the change notice before persistence resolves.
    usagePercentageDisplayChangeNoticeDismissed: true,
    dismissUsagePercentageDisplayChangeNotice: () =>
      set((s) => {
        if (s.usagePercentageDisplayChangeNoticeDismissed) {
          return s
        }
        window.api.ui
          .set({ usagePercentageDisplayChangeNoticeDismissed: true })
          .catch(console.error)
        return { usagePercentageDisplayChangeNoticeDismissed: true }
      }),
    statusBarCompactChangeNoticeDismissed: true,
    dismissStatusBarCompactChangeNotice: () =>
      set((s) => {
        if (s.statusBarCompactChangeNoticeDismissed) {
          return s
        }
        window.api.ui.set({ statusBarCompactChangeNoticeDismissed: true }).catch(console.error)
        return { statusBarCompactChangeNoticeDismissed: true }
      }),
    usageEmptyStateDismissed: false,
    dismissUsageEmptyState: () =>
      set((s) => {
        if (s.usageEmptyStateDismissed) {
          return s
        }
        window.api.ui.set({ usageEmptyStateDismissed: true }).catch(console.error)
        return { usageEmptyStateDismissed: true }
      }),
    // Why default true: nothing may toast before hydration reads the persisted flag.
    codexTerminalServerIsolationNoticeSeen: true,
    markCodexTerminalServerIsolationNoticeSeen: () =>
      set((s) => {
        if (s.codexTerminalServerIsolationNoticeSeen) {
          return s
        }
        window.api.ui.set({ codexTerminalServerIsolationNoticeSeen: true }).catch(console.error)
        return { codexTerminalServerIsolationNoticeSeen: true }
      }),
    codexSharedSettingsNoticeSeen: true,
    markCodexSharedSettingsNoticeSeen: () =>
      set((s) => {
        if (s.codexSharedSettingsNoticeSeen) {
          return s
        }
        window.api.ui.set({ codexSharedSettingsNoticeSeen: true }).catch(console.error)
        return { codexSharedSettingsNoticeSeen: true }
      }),
    claudeDiffPanelNoticeSeen: true,
    markClaudeDiffPanelNoticeSeen: () =>
      set((s) => {
        if (s.claudeDiffPanelNoticeSeen) {
          return s
        }
        window.api.ui.set({ claudeDiffPanelNoticeSeen: true }).catch(console.error)
        return { claudeDiffPanelNoticeSeen: true }
      })
  }
}
