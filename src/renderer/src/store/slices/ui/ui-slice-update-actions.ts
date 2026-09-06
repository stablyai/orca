import type { UISlice, UISliceGet, UISliceSet } from './ui-slice-contract'
import {
  DEFAULT_BROWSER_PAGE_ZOOM_LEVEL,
  normalizeBrowserPageZoomLevel
} from '../../../../../shared/browser-page-zoom'
import { normalizeKagiSessionLink } from '../../../../../shared/browser-url'
export function createUiUpdateActions(set: UISliceSet, get: UISliceGet): Partial<UISlice> {
  return {
    updateStatus: { state: 'idle' },
    setUpdateStatus: (status) => {
      const prevState = get().updateStatus.state
      const update: Partial<
        Pick<
          UISlice,
          'updateStatus' | 'updateChangelog' | 'updateCardCollapsed' | 'updateUserInitiatedCycle'
        >
      > = {
        updateStatus: status
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
      if (status.state !== prevState) {
        // Why: re-surface the card on each phase transition so a collapsed `downloading` doesn't bury `downloaded`/`error`.
        update.updateCardCollapsed = false
      }
      set(update)
    },
    updateChangelog: null,
    updateUserInitiatedCycle: false,
    dismissedUpdateVersion: null,
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
    osc52ClipboardDefaultOnNoticePending: false,
    clearOsc52ClipboardDefaultOnNotice: () => {
      // Why clear locally first: a failed persist must not re-toast this session. It will
      // re-arm on the next launch, which is the safe direction for a one-shot notice.
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
    }
  }
}
