import { createBrowserAnnotationActions } from './annotations/browser-annotation-actions'
import { createBrowserPageViewportActions } from './pages/browser-page-viewport-actions'
import { createBrowserRemotePageHandleActions } from './hosts/browser-remote-page-handle-actions'
import { createBrowserProfileSwitchActions } from './profiles/browser-profile-switch-actions'
import type { StateCreator } from 'zustand'
import type { AppState } from '../../types'
import type { BrowserSlice } from './browser-slice-contract'
import { createBrowserHostActions } from './hosts/browser-host-actions'
import { createBrowserTabActions } from './tabs/browser-tab-actions'
import { createBrowserCloseActions } from './cleanup/browser-close-actions'
import { createBrowserTabFocusActions } from './tabs/browser-tab-focus-actions'
import { createBrowserPageCreateActions } from './pages/browser-page-create-actions'
import { createBrowserPageConversionActions } from './pages/browser-page-conversion-actions'
import { createBrowserPageFocusActions } from './pages/browser-page-focus-actions'
import { createBrowserPageStateActions } from './pages/browser-page-state-actions'
import { createBrowserAudioActions } from './audio/browser-audio-actions'
import { createBrowserHydrationActions } from './hydration/browser-hydration-actions'
import { createBrowserProfileListActions } from './profiles/browser-profile-list-actions'
import { createBrowserManagedProfileActions } from './profiles/browser-managed-profile-actions'
import { createBrowserProfileImportActions } from './profiles/browser-profile-import-actions'
import { createBrowserCookieImportActions } from './profiles/browser-cookie-import-actions'
import { createBrowserHistoryActions } from './history/browser-history-actions'

export const createBrowserSlice: StateCreator<AppState, [], [], BrowserSlice> = (set, get) => ({
  browserTabsByWorktree: {},
  browserPagesByWorkspace: {},
  browserCertificateFailuresByPageId: {},
  browserAudiblePageIds: {},
  browserAudioMutedTabIds: {},
  browserAnnotationsByPageId: {},
  browserAnnotationMarkerIdsByPageId: {},
  remoteBrowserPageHandlesByPageId: {},
  clientHostedBrowserCloseIntentsByEnvironment: {},
  activeBrowserTabId: null,
  activeBrowserTabIdByWorktree: {},
  recentlyClosedBrowserTabsByWorktree: {},
  recentlyClosedBrowserPagesByWorkspace: {},
  pendingAddressBarFocusByTabId: {},
  pendingAddressBarFocusByPageId: {},
  browserSessionProfiles: [],
  browserSessionProfilesByHostId: {},
  managedBrowserProfileStatusById: {},
  browserSessionHostIdOverride: null,
  browserSessionImportState: null,
  browserUrlHistory: [],
  workspaceDocHistory: [],
  browserHistoryPageId: null,
  detectedBrowsers: [],
  detectedBrowsersLoaded: false,
  detectedBrowsersHost: null,
  ...createBrowserHostActions(set, get),
  ...createBrowserTabActions(set, get),
  ...createBrowserCloseActions(set, get),
  ...createBrowserTabFocusActions(set, get),
  ...createBrowserPageCreateActions(set, get),
  ...createBrowserPageConversionActions(set, get),
  ...createBrowserPageFocusActions(set, get),
  ...createBrowserPageStateActions(set, get),
  ...createBrowserAudioActions(set, get),
  ...createBrowserRemotePageHandleActions(set),
  ...createBrowserPageViewportActions(set),
  ...createBrowserAnnotationActions(set),
  ...createBrowserHydrationActions(set, get),
  ...createBrowserProfileSwitchActions(set, get),
  ...createBrowserProfileListActions(set, get),
  ...createBrowserManagedProfileActions(set, get),
  ...createBrowserProfileImportActions(set, get),
  ...createBrowserCookieImportActions(set, get),
  ...createBrowserHistoryActions(set, get)
})
