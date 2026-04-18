import type { StateCreator } from 'zustand';
import type { AppState } from '../types';
import type { BrowserCookieImportResult, BrowserCookieImportSummary, BrowserHistoryEntry, BrowserLoadError, BrowserPage, BrowserSessionProfile, BrowserWorkspace, WorkspaceSessionState } from '../../../../shared/types';
type CreateBrowserTabOptions = {
    activate?: boolean;
    title?: string;
    sessionProfileId?: string | null;
};
type CreateBrowserPageOptions = {
    activate?: boolean;
    title?: string;
};
type BrowserTabPageState = {
    title?: string;
    loading?: boolean;
    faviconUrl?: string | null;
    canGoBack?: boolean;
    canGoForward?: boolean;
    loadError?: BrowserLoadError | null;
};
type ClosedBrowserWorkspaceSnapshot = {
    workspace: BrowserWorkspace;
    pages: BrowserPage[];
};
export type BrowserSlice = {
    browserTabsByWorktree: Record<string, BrowserWorkspace[]>;
    browserPagesByWorkspace: Record<string, BrowserPage[]>;
    activeBrowserTabId: string | null;
    activeBrowserTabIdByWorktree: Record<string, string | null>;
    recentlyClosedBrowserTabsByWorktree: Record<string, ClosedBrowserWorkspaceSnapshot[]>;
    recentlyClosedBrowserPagesByWorkspace: Record<string, BrowserPage[]>;
    pendingAddressBarFocusByTabId: Record<string, true>;
    pendingAddressBarFocusByPageId: Record<string, true>;
    createBrowserTab: (worktreeId: string, url: string, options?: CreateBrowserTabOptions) => BrowserWorkspace;
    closeBrowserTab: (tabId: string) => void;
    reopenClosedBrowserTab: (worktreeId: string) => BrowserWorkspace | null;
    setActiveBrowserTab: (tabId: string) => void;
    createBrowserPage: (workspaceId: string, url: string, options?: CreateBrowserPageOptions) => BrowserPage | null;
    closeBrowserPage: (pageId: string) => void;
    reopenClosedBrowserPage: (workspaceId: string) => BrowserPage | null;
    setActiveBrowserPage: (workspaceId: string, pageId: string) => void;
    consumeAddressBarFocusRequest: (pageId: string) => boolean;
    updateBrowserTabPageState: (pageId: string, updates: BrowserTabPageState) => void;
    updateBrowserPageState: (pageId: string, updates: BrowserTabPageState) => void;
    setBrowserTabUrl: (pageId: string, url: string) => void;
    setBrowserPageUrl: (pageId: string, url: string) => void;
    hydrateBrowserSession: (session: WorkspaceSessionState) => void;
    browserSessionProfiles: BrowserSessionProfile[];
    browserSessionImportState: {
        profileId: string;
        status: 'idle' | 'importing' | 'success' | 'error';
        summary: BrowserCookieImportSummary | null;
        error: string | null;
    } | null;
    fetchBrowserSessionProfiles: () => Promise<void>;
    createBrowserSessionProfile: (scope: 'isolated' | 'imported', label: string) => Promise<BrowserSessionProfile | null>;
    deleteBrowserSessionProfile: (profileId: string) => Promise<boolean>;
    importCookiesToProfile: (profileId: string) => Promise<BrowserCookieImportResult>;
    clearBrowserSessionImportState: () => void;
    detectedBrowsers: {
        family: string;
        label: string;
        profiles: {
            name: string;
            directory: string;
        }[];
        selectedProfile: string;
    }[];
    fetchDetectedBrowsers: () => Promise<void>;
    importCookiesFromBrowser: (profileId: string, browserFamily: string, browserProfile?: string) => Promise<BrowserCookieImportResult>;
    clearDefaultSessionCookies: () => Promise<boolean>;
    browserUrlHistory: BrowserHistoryEntry[];
    addBrowserHistoryEntry: (url: string, title: string) => void;
    clearBrowserHistory: () => void;
};
export declare const createBrowserSlice: StateCreator<AppState, [], [], BrowserSlice>;
export {};
