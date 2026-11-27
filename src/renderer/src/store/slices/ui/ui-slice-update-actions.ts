import type { UISlice, UISliceGet, UISliceSet } from './ui-slice-contract'
import { reconcileRetainedUpdateTarget } from './retained-update-target'
import {
  DEFAULT_BROWSER_PAGE_ZOOM_LEVEL,
  normalizeBrowserPageZoomLevel
} from '../../../../../shared/browser/site-settings/browser-page-zoom'
import { normalizeKagiSessionLink } from '../../../../../shared/browser/navigation/browser-url'
import { DEFAULT_BROWSER_DEVTOOLS_DOCK_LAYOUT } from '../../../../../shared/browser/devtools/browser-devtools-dock'
import {
  DEFAULT_BROWSER_EXTENSION_SIDE_PANEL_WIDTH,
  normalizeBrowserExtensionSidePanelWidth
} from '../../../../../shared/browser/extensions/browser-extension-side-panel-types'
export function createUiUpdateActions(set: UISliceSet, get: UISliceGet): Partial<UISlice> {
  return {
    updateStatus: { state: 'idle' },
    retainedUpdateTarget: null,
    setUpdateStatus: (status) => {
      const { updateStatus: previousStatus, retainedUpdateTarget, updateUserInitiatedCycle } = get()
      const update: Partial<
        Pick<
          UISlice,
          | 'updateStatus'
          | 'retainedUpdateTarget'
          | 'updateChangelog'
          | 'updateCardCollapsed'
          | 'updateUserInitiatedCycle'
        >
      > = {
        updateStatus: status,
        retainedUpdateTarget: reconcileRetainedUpdateTarget(retainedUpdateTarget, status)
      }
      if (status.state === 'checking') {
        update.updateUserInitiatedCycle = status.userInitiated === true
      } else if (status.state === 'idle') {
        update.updateUserInitiatedCycle = false
      }
      if (status.state === 'available') {
        // Why: always overwrite (even with null) so a prior version's changelog can't leak into a later simple-mode update.
        update.updateChangelog = status.changelog ?? null
      } else if (
        status.state === 'idle' ||
        status.state === 'checking' ||
        status.state === 'not-available'
      ) {
        // Why: reset on cycle-boundary states so stale rich content from a previous cycle can't resurface.
        update.updateChangelog = null
      }
      // 'downloading'/'downloaded'/'error': leave updateChangelog untouched to keep the original 'available' content.
      const errorBecameActionable =
        status.state === 'error' &&
        previousStatus.state === 'error' &&
        ((status.userInitiated === true && !previousStatus.userInitiated) ||
          (status.version !== undefined && previousStatus.version === undefined) ||
          (status.recovery?.kind === 'linux-package-install' &&
            previousStatus.recovery?.kind !== 'linux-package-install'))
      const installStateChanged =
        status.state === 'downloaded' &&
        previousStatus.state === 'downloaded' &&
        Boolean(status.installing) !== Boolean(previousStatus.installing)
      if (status.state !== previousStatus.state || errorBecameActionable || installStateChanged) {
        // Quiet check failures start collapsed so the status bar can still disclose them.
        update.updateCardCollapsed =
          (status.automaticDownload === true &&
            (status.state === 'downloading' ||
              (status.state === 'downloaded' && status.installing === true) ||
              (status.state === 'error' && status.retryAction !== 'install'))) ||
          (status.state === 'error' &&
            !status.userInitiated &&
            !updateUserInitiatedCycle &&
            status.version === undefined &&
            status.recovery?.kind !== 'linux-package-install' &&
            !('version' in previousStatus && previousStatus.version !== undefined))
      }
      set(update)
    },
    updateChangelog: null,
    updateUserInitiatedCycle: false,
    dismissedUpdateVersion: null,
    dismissedUnexpectedSignoutVersion: null,
    unexpectedSignoutDismissedVersions: [],
    dismissUnexpectedSignoutCard: (version) => {
      if (get().unexpectedSignoutDismissedVersions.includes(version)) {
        return
      }
      set({
        dismissedUnexpectedSignoutVersion: version,
        unexpectedSignoutDismissedVersions: [...get().unexpectedSignoutDismissedVersions, version]
      })
      void window.api.ui.set({ dismissedUnexpectedSignoutVersion: version }).catch(console.error)
    },
    clearDismissedUpdateVersion: () => {
      set({ dismissedUpdateVersion: null })
    },
    releaseChannelOverride: null,
    setReleaseChannelOverride: (channel) => {
      void window.api.ui.set({ releaseChannelOverride: channel }).catch(console.error)
      set({ releaseChannelOverride: channel })
    },
    dismissUpdate: (versionOverride?: string) =>
      set((s) => {
        // Why: the 'error' variant has no version field, so the card passes it via versionOverride.
        const dismissedUpdateVersion =
          versionOverride ?? ('version' in s.updateStatus ? (s.updateStatus.version ?? null) : null)
        const activeNudgeId =
          'activeNudgeId' in s.updateStatus ? (s.updateStatus.activeNudgeId ?? null) : null
        // Why: persist dismissal so relaunch doesn't immediately re-show the same card until a newer release.
        void window.api.ui.set({ dismissedUpdateVersion }).catch(console.error)
        // Why: main can't otherwise tell an offered update was abandoned, which keeps a local-build session pinned and stalls background checks.
        void window.api.updater.dismissAvailableUpdate().catch(console.error)
        // Why: only consume the nudge campaign for cards from a nudge cycle, not ordinary dismissals.
        if (activeNudgeId) {
          void window.api.updater.dismissNudge().catch(console.error)
        }
        return { dismissedUpdateVersion, updateUserInitiatedCycle: false }
      }),
    updateCardCollapsed: false,
    setUpdateCardCollapsed: (collapsed) => set({ updateCardCollapsed: collapsed }),
    updateReassuranceSeen: false,
    markUpdateReassuranceSeen: () => {
      void window.api.ui.set({ updateReassuranceSeen: true }).catch(console.error)
      set({ updateReassuranceSeen: true })
    },
    seenMacosUpdateRequirement: null,
    markMacosUpdateRequirementSeen: (minimumMacosVersion) => {
      void window.api.ui
        .set({ seenMacosUpdateRequirement: minimumMacosVersion })
        .catch(console.error)
      set({ seenMacosUpdateRequirement: minimumMacosVersion })
    },
    osc52ClipboardDefaultOnNoticePending: false,
    clearOsc52ClipboardDefaultOnNotice: () => {
      // Clear locally before persisting to prevent repeat toasts on failure; next launch may re-arm the notice.
      set({ osc52ClipboardDefaultOnNoticePending: false })
      void window.api.ui.set({ osc52ClipboardDefaultOnNoticePending: false }).catch(console.error)
    },
    isFullScreen: false,
    setIsFullScreen: (v) => set({ isFullScreen: v }),
    browserDefaultUrl: null,
    setBrowserDefaultUrl: (url) => {
      void window.api.ui.set({ browserDefaultUrl: url }).catch(console.error)
      set({ browserDefaultUrl: url })
    },
    browserDefaultSearchEngine: null,
    setBrowserDefaultSearchEngine: (engine) => {
      void window.api.ui.set({ browserDefaultSearchEngine: engine }).catch(console.error)
      set({ browserDefaultSearchEngine: engine })
    },
    browserDefaultZoomLevel: DEFAULT_BROWSER_PAGE_ZOOM_LEVEL,
    setBrowserDefaultZoomLevel: (level) => {
      const normalized = normalizeBrowserPageZoomLevel(level)
      void window.api.ui.set({ browserDefaultZoomLevel: normalized }).catch(console.error)
      set({ browserDefaultZoomLevel: normalized })
    },
    browserKagiSessionLink: null,
    setBrowserKagiSessionLink: (link) => {
      const normalized = link ? normalizeKagiSessionLink(link) : null
      void window.api.ui.set({ browserKagiSessionLink: normalized }).catch(console.error)
      set({ browserKagiSessionLink: normalized })
    },
    browserDevToolsDock: DEFAULT_BROWSER_DEVTOOLS_DOCK_LAYOUT,
    setBrowserDevToolsDock: (layout) => {
      void window.api.ui.set({ browserDevToolsDock: layout }).catch(console.error)
      set({ browserDevToolsDock: layout })
    },
    browserExtensionSidePanelWidth: DEFAULT_BROWSER_EXTENSION_SIDE_PANEL_WIDTH,
    setBrowserExtensionSidePanelWidth: (width) => {
      const normalized = normalizeBrowserExtensionSidePanelWidth(width)
      void window.api.ui.set({ browserExtensionSidePanelWidth: normalized }).catch(console.error)
      set({ browserExtensionSidePanelWidth: normalized })
    }
  }
}
