import type { StateCreator } from 'zustand'
import type { AppState } from '../../types'
import type { BrowserSlice } from './browser-slice-contract'
import { createBrowserHostActions } from './browser-host-actions'
import { createBrowserTabActions } from './browser-tab-actions'
import { createBrowserCloseActions } from './browser-close-actions'
import { createBrowserTabFocusActions } from './browser-tab-focus-actions'
import { createBrowserPageCreateActions } from './browser-page-create-actions'
import { createBrowserPageConversionActions } from './browser-page-conversion-actions'
import { createBrowserPageFocusActions } from './browser-page-focus-actions'
import { createBrowserPageStateActions } from './browser-page-state-actions'
import { createBrowserPageMetadataActions } from './browser-page-metadata-actions'
import { createBrowserHydrationActions } from './browser-hydration-actions'
import { createBrowserProfileListActions } from './browser-profile-list-actions'
import { createBrowserProfileImportActions } from './browser-profile-import-actions'
import { createBrowserCookieImportActions } from './browser-cookie-import-actions'
import { createBrowserHistoryActions } from './browser-history-actions'

export const createBrowserSlice: StateCreator<AppState, [], [], BrowserSlice> = (set, get) => ({
  browserTabsByWorktree: {},
  browserPagesByWorkspace: {},
  browserCertificateFailuresByPageId: {},
  browserAnnotationsByPageId: {},
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
  browserSessionHostIdOverride: null,
  browserSessionImportState: null,
  browserUrlHistory: [],
  workspaceDocHistory: [],
  defaultBrowserSessionProfileId: null,
  defaultBrowserSessionProfileIdByHostId: {},
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
  ...createBrowserPageMetadataActions(set, get),
  ...createBrowserHydrationActions(set, get),
  ...createBrowserProfileListActions(set, get),
  ...createBrowserProfileImportActions(set, get),
  ...createBrowserCookieImportActions(set, get),
  ...createBrowserHistoryActions(set, get)
})
