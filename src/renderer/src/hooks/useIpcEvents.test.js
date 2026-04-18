import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveZoomTarget } from './useIpcEvents';
function makeTarget(args) {
    const { hasXtermClass = false, editorClosest = false } = args;
    return {
        classList: {
            contains: (token) => hasXtermClass && token === 'xterm-helper-textarea'
        },
        closest: () => (editorClosest ? {} : null)
    };
}
describe('resolveZoomTarget', () => {
    it('routes to terminal zoom when terminal tab is active', () => {
        expect(resolveZoomTarget({
            activeView: 'terminal',
            activeTabType: 'terminal',
            activeElement: makeTarget({ hasXtermClass: true })
        })).toBe('terminal');
    });
    it('routes to editor zoom for editor tabs', () => {
        expect(resolveZoomTarget({
            activeView: 'terminal',
            activeTabType: 'editor',
            activeElement: makeTarget({})
        })).toBe('editor');
    });
    it('routes to editor zoom when editor surface has focus during stale tab state', () => {
        expect(resolveZoomTarget({
            activeView: 'terminal',
            activeTabType: 'terminal',
            activeElement: makeTarget({ editorClosest: true })
        })).toBe('editor');
    });
    it('routes to ui zoom outside terminal view', () => {
        expect(resolveZoomTarget({
            activeView: 'settings',
            activeTabType: 'terminal',
            activeElement: makeTarget({ hasXtermClass: true })
        })).toBe('ui');
    });
});
describe('useIpcEvents updater integration', () => {
    beforeEach(() => {
        vi.resetModules();
        vi.unstubAllGlobals();
    });
    it('routes updater status events into store state', async () => {
        const setUpdateStatus = vi.fn();
        const removeSshCredentialRequest = vi.fn();
        const updaterStatusListenerRef = {
            current: null
        };
        const credentialResolvedListenerRef = {
            current: null
        };
        vi.doMock('react', async () => {
            const actual = await vi.importActual('react');
            return {
                ...actual,
                useEffect: (effect) => {
                    effect();
                }
            };
        });
        vi.doMock('../store', () => ({
            useAppStore: {
                getState: () => ({
                    setUpdateStatus,
                    fetchRepos: vi.fn(),
                    fetchWorktrees: vi.fn(),
                    setActiveView: vi.fn(),
                    activeModal: null,
                    closeModal: vi.fn(),
                    openModal: vi.fn(),
                    activeWorktreeId: 'wt-1',
                    activeView: 'terminal',
                    setActiveRepo: vi.fn(),
                    setActiveWorktree: vi.fn(),
                    revealWorktreeInSidebar: vi.fn(),
                    setIsFullScreen: vi.fn(),
                    updateBrowserTabPageState: vi.fn(),
                    activeTabType: 'terminal',
                    editorFontZoomLevel: 0,
                    setEditorFontZoomLevel: vi.fn(),
                    setRateLimitsFromPush: vi.fn(),
                    setSshConnectionState: vi.fn(),
                    setSshTargetLabels: vi.fn(),
                    enqueueSshCredentialRequest: vi.fn(),
                    removeSshCredentialRequest,
                    settings: { terminalFontSize: 13 }
                })
            }
        }));
        vi.doMock('@/lib/ui-zoom', () => ({
            applyUIZoom: vi.fn()
        }));
        vi.doMock('@/lib/worktree-activation', () => ({
            activateAndRevealWorktree: vi.fn(),
            ensureWorktreeHasInitialTerminal: vi.fn()
        }));
        vi.doMock('@/components/sidebar/visible-worktrees', () => ({
            getVisibleWorktreeIds: () => []
        }));
        vi.doMock('@/lib/editor-font-zoom', () => ({
            nextEditorFontZoomLevel: vi.fn(() => 0),
            computeEditorFontSize: vi.fn(() => 13)
        }));
        vi.doMock('@/components/settings/SettingsConstants', () => ({
            zoomLevelToPercent: vi.fn(() => 100),
            ZOOM_MIN: -3,
            ZOOM_MAX: 3
        }));
        vi.doMock('@/lib/zoom-events', () => ({
            dispatchZoomLevelChanged: vi.fn()
        }));
        vi.stubGlobal('window', {
            api: {
                repos: { onChanged: () => () => { } },
                worktrees: { onChanged: () => () => { } },
                ui: {
                    onOpenSettings: () => () => { },
                    onToggleLeftSidebar: () => () => { },
                    onToggleRightSidebar: () => () => { },
                    onToggleWorktreePalette: () => () => { },
                    onOpenQuickOpen: () => () => { },
                    onJumpToWorktreeIndex: () => () => { },
                    onActivateWorktree: () => () => { },
                    onNewBrowserTab: () => () => { },
                    onNewTerminalTab: () => () => { },
                    onCloseActiveTab: () => () => { },
                    onSwitchTab: () => () => { },
                    onToggleStatusBar: () => () => { },
                    onFullscreenChanged: () => () => { },
                    onTerminalZoom: () => () => { },
                    getZoomLevel: () => 0,
                    set: vi.fn()
                },
                updater: {
                    getStatus: () => Promise.resolve({ state: 'idle' }),
                    onStatus: (listener) => {
                        updaterStatusListenerRef.current = listener;
                        return () => { };
                    },
                    onClearDismissal: () => () => { }
                },
                browser: {
                    onGuestLoadFailed: () => () => { },
                    onOpenLinkInOrcaTab: () => () => { }
                },
                rateLimits: {
                    get: () => Promise.resolve({ limits: {}, lastUpdatedAt: Date.now() }),
                    onUpdate: () => () => { }
                },
                ssh: {
                    listTargets: () => Promise.resolve([]),
                    getState: () => Promise.resolve(null),
                    onStateChanged: () => () => { },
                    onCredentialRequest: () => () => { },
                    onCredentialResolved: (listener) => {
                        credentialResolvedListenerRef.current = listener;
                        return () => { };
                    }
                }
            }
        });
        const { useIpcEvents } = await import('./useIpcEvents');
        useIpcEvents();
        await Promise.resolve();
        expect(setUpdateStatus).toHaveBeenCalledWith({ state: 'idle' });
        const availableStatus = { state: 'available', version: '1.2.3' };
        if (typeof updaterStatusListenerRef.current !== 'function') {
            throw new Error('Expected updater status listener to be registered');
        }
        updaterStatusListenerRef.current(availableStatus);
        expect(setUpdateStatus).toHaveBeenCalledWith(availableStatus);
        if (typeof credentialResolvedListenerRef.current !== 'function') {
            throw new Error('Expected credential resolved listener to be registered');
        }
        credentialResolvedListenerRef.current({ requestId: 'req-1' });
        expect(removeSshCredentialRequest).toHaveBeenCalledWith('req-1');
    });
    it('clears stale remote PTYs when an SSH connection fully disconnects', async () => {
        const clearTabPtyId = vi.fn();
        const setSshConnectionState = vi.fn();
        const sshStateListenerRef = {
            current: null
        };
        const storeState = {
            setUpdateStatus: vi.fn(),
            fetchRepos: vi.fn(),
            fetchWorktrees: vi.fn(),
            setActiveView: vi.fn(),
            activeModal: null,
            closeModal: vi.fn(),
            openModal: vi.fn(),
            activeWorktreeId: 'wt-1',
            activeView: 'terminal',
            setActiveRepo: vi.fn(),
            setActiveWorktree: vi.fn(),
            revealWorktreeInSidebar: vi.fn(),
            setIsFullScreen: vi.fn(),
            updateBrowserTabPageState: vi.fn(),
            activeTabType: 'terminal',
            editorFontZoomLevel: 0,
            setEditorFontZoomLevel: vi.fn(),
            setRateLimitsFromPush: vi.fn(),
            setSshConnectionState,
            setSshTargetLabels: vi.fn(),
            enqueueSshCredentialRequest: vi.fn(),
            removeSshCredentialRequest: vi.fn(),
            clearTabPtyId,
            repos: [{ id: 'repo-1', connectionId: 'conn-1' }],
            worktreesByRepo: {
                'repo-1': [{ id: 'wt-1', repoId: 'repo-1' }]
            },
            tabsByWorktree: {
                'wt-1': [
                    { id: 'tab-1', ptyId: 'pty-1', worktreeId: 'wt-1', title: 'Terminal 1' },
                    { id: 'tab-2', ptyId: null, worktreeId: 'wt-1', title: 'Terminal 2' }
                ]
            },
            sshTargetLabels: new Map([['conn-1', 'Remote']]),
            settings: { terminalFontSize: 13 }
        };
        vi.doMock('react', async () => {
            const actual = await vi.importActual('react');
            return {
                ...actual,
                useEffect: (effect) => {
                    effect();
                }
            };
        });
        vi.doMock('../store', () => ({
            useAppStore: {
                getState: () => storeState,
                setState: vi.fn((updater) => updater(storeState))
            }
        }));
        vi.doMock('@/lib/ui-zoom', () => ({
            applyUIZoom: vi.fn()
        }));
        vi.doMock('@/lib/worktree-activation', () => ({
            activateAndRevealWorktree: vi.fn(),
            ensureWorktreeHasInitialTerminal: vi.fn()
        }));
        vi.doMock('@/components/sidebar/visible-worktrees', () => ({
            getVisibleWorktreeIds: () => []
        }));
        vi.doMock('@/lib/editor-font-zoom', () => ({
            nextEditorFontZoomLevel: vi.fn(() => 0),
            computeEditorFontSize: vi.fn(() => 13)
        }));
        vi.doMock('@/components/settings/SettingsConstants', () => ({
            zoomLevelToPercent: vi.fn(() => 100),
            ZOOM_MIN: -3,
            ZOOM_MAX: 3
        }));
        vi.doMock('@/lib/zoom-events', () => ({
            dispatchZoomLevelChanged: vi.fn()
        }));
        vi.stubGlobal('window', {
            api: {
                repos: { onChanged: () => () => { } },
                worktrees: { onChanged: () => () => { } },
                ui: {
                    onOpenSettings: () => () => { },
                    onToggleLeftSidebar: () => () => { },
                    onToggleRightSidebar: () => () => { },
                    onToggleWorktreePalette: () => () => { },
                    onOpenQuickOpen: () => () => { },
                    onJumpToWorktreeIndex: () => () => { },
                    onActivateWorktree: () => () => { },
                    onNewBrowserTab: () => () => { },
                    onNewTerminalTab: () => () => { },
                    onCloseActiveTab: () => () => { },
                    onSwitchTab: () => () => { },
                    onToggleStatusBar: () => () => { },
                    onFullscreenChanged: () => () => { },
                    onTerminalZoom: () => () => { },
                    getZoomLevel: () => 0,
                    set: vi.fn()
                },
                updater: {
                    getStatus: () => Promise.resolve({ state: 'idle' }),
                    onStatus: () => () => { },
                    onClearDismissal: () => () => { }
                },
                browser: {
                    onGuestLoadFailed: () => () => { },
                    onOpenLinkInOrcaTab: () => () => { }
                },
                rateLimits: {
                    get: () => Promise.resolve({ limits: {}, lastUpdatedAt: Date.now() }),
                    onUpdate: () => () => { }
                },
                ssh: {
                    listTargets: () => Promise.resolve([]),
                    getState: () => Promise.resolve(null),
                    onStateChanged: (listener) => {
                        sshStateListenerRef.current = listener;
                        return () => { };
                    },
                    onCredentialRequest: () => () => { },
                    onCredentialResolved: () => () => { }
                }
            }
        });
        const { useIpcEvents } = await import('./useIpcEvents');
        useIpcEvents();
        await Promise.resolve();
        if (typeof sshStateListenerRef.current !== 'function') {
            throw new Error('Expected ssh state listener to be registered');
        }
        sshStateListenerRef.current({
            targetId: 'conn-1',
            state: { status: 'disconnected', error: null, reconnectAttempt: 0 }
        });
        expect(setSshConnectionState).toHaveBeenCalledWith('conn-1', expect.objectContaining({ status: 'disconnected' }));
        expect(clearTabPtyId).toHaveBeenCalledWith('tab-1');
        expect(clearTabPtyId).not.toHaveBeenCalledWith('tab-2');
    });
});
describe('useIpcEvents shortcut hint clearing', () => {
    beforeEach(() => {
        vi.resetModules();
        vi.unstubAllGlobals();
    });
    it('clears modifier hints for main-process-forwarded shortcuts', async () => {
        const toggleLeftSidebarRef = { current: null };
        const jumpToWorktreeRef = { current: null };
        const toggleSidebar = vi.fn();
        const dispatchEvent = vi.fn();
        const activateAndRevealWorktree = vi.fn();
        vi.doMock('react', async () => {
            const actual = await vi.importActual('react');
            return {
                ...actual,
                useEffect: (effect) => {
                    effect();
                }
            };
        });
        vi.doMock('../store', () => ({
            useAppStore: {
                getState: () => ({
                    toggleSidebar,
                    toggleRightSidebar: vi.fn(),
                    activeModal: 'none',
                    closeModal: vi.fn(),
                    openModal: vi.fn(),
                    activeView: 'terminal',
                    activeWorktreeId: 'wt-1',
                    statusBarVisible: true,
                    setStatusBarVisible: vi.fn(),
                    fetchRepos: vi.fn(),
                    fetchWorktrees: vi.fn(),
                    setActiveView: vi.fn(),
                    setActiveRepo: vi.fn(),
                    setActiveWorktree: vi.fn(),
                    revealWorktreeInSidebar: vi.fn(),
                    setIsFullScreen: vi.fn(),
                    updateBrowserPageState: vi.fn(),
                    createBrowserTab: vi.fn(),
                    browserDefaultUrl: 'about:blank',
                    createTab: vi.fn(),
                    setActiveTabType: vi.fn(),
                    tabsByWorktree: {},
                    openFiles: [],
                    browserTabsByWorktree: {},
                    tabBarOrderByWorktree: {},
                    setTabBarOrder: vi.fn(),
                    activeBrowserTabId: null,
                    closeBrowserTab: vi.fn(),
                    activeTabType: 'terminal',
                    editorFontZoomLevel: 0,
                    setUpdateStatus: vi.fn(),
                    setEditorFontZoomLevel: vi.fn(),
                    setRateLimitsFromPush: vi.fn(),
                    setSshConnectionState: vi.fn(),
                    setSshTargetLabels: vi.fn(),
                    enqueueSshCredentialRequest: vi.fn(),
                    removeSshCredentialRequest: vi.fn(),
                    clearTabPtyId: vi.fn(),
                    tabs: [],
                    settings: { terminalFontSize: 13 }
                })
            }
        }));
        vi.doMock('@/lib/ui-zoom', () => ({
            applyUIZoom: vi.fn()
        }));
        vi.doMock('@/lib/worktree-activation', () => ({
            activateAndRevealWorktree,
            ensureWorktreeHasInitialTerminal: vi.fn()
        }));
        vi.doMock('@/components/sidebar/visible-worktrees', () => ({
            getVisibleWorktreeIds: () => ['wt-1', 'wt-2']
        }));
        vi.doMock('@/lib/editor-font-zoom', () => ({
            nextEditorFontZoomLevel: vi.fn(() => 0),
            computeEditorFontSize: vi.fn(() => 13)
        }));
        vi.doMock('@/components/settings/SettingsConstants', () => ({
            zoomLevelToPercent: vi.fn(() => 100),
            ZOOM_MIN: -3,
            ZOOM_MAX: 3
        }));
        vi.doMock('@/lib/zoom-events', () => ({
            dispatchZoomLevelChanged: vi.fn()
        }));
        vi.stubGlobal('window', {
            dispatchEvent,
            api: {
                repos: { onChanged: () => () => { } },
                worktrees: { onChanged: () => () => { } },
                ui: {
                    onOpenSettings: () => () => { },
                    onToggleLeftSidebar: (listener) => {
                        toggleLeftSidebarRef.current = listener;
                        return () => { };
                    },
                    onToggleRightSidebar: () => () => { },
                    onToggleWorktreePalette: () => () => { },
                    onOpenQuickOpen: () => () => { },
                    onJumpToWorktreeIndex: (listener) => {
                        jumpToWorktreeRef.current = listener;
                        return () => { };
                    },
                    onActivateWorktree: () => () => { },
                    onNewBrowserTab: () => () => { },
                    onNewTerminalTab: () => () => { },
                    onCloseActiveTab: () => () => { },
                    onSwitchTab: () => () => { },
                    onToggleStatusBar: () => () => { },
                    onFullscreenChanged: () => () => { },
                    onTerminalZoom: () => () => { },
                    getZoomLevel: () => 0,
                    set: vi.fn()
                },
                updater: {
                    getStatus: () => Promise.resolve({ state: 'idle' }),
                    onStatus: () => () => { },
                    onClearDismissal: () => () => { }
                },
                browser: {
                    onGuestLoadFailed: () => () => { },
                    onOpenLinkInOrcaTab: () => () => { }
                },
                rateLimits: {
                    get: () => Promise.resolve({ limits: {}, lastUpdatedAt: Date.now() }),
                    onUpdate: () => () => { }
                },
                ssh: {
                    listTargets: () => Promise.resolve([]),
                    getState: () => Promise.resolve(null),
                    onStateChanged: () => () => { },
                    onCredentialRequest: () => () => { },
                    onCredentialResolved: () => () => { }
                }
            }
        });
        const { useIpcEvents } = await import('./useIpcEvents');
        useIpcEvents();
        await Promise.resolve();
        if (typeof toggleLeftSidebarRef.current !== 'function') {
            throw new Error('Expected toggle-left-sidebar listener to be registered');
        }
        if (typeof jumpToWorktreeRef.current !== 'function') {
            throw new Error('Expected jump-to-worktree listener to be registered');
        }
        toggleLeftSidebarRef.current();
        jumpToWorktreeRef.current(1);
        expect(dispatchEvent).toHaveBeenCalledWith(expect.objectContaining({ type: 'orca:clear-modifier-hints' }));
        expect(dispatchEvent).toHaveBeenCalledTimes(2);
        expect(toggleSidebar).toHaveBeenCalledTimes(1);
        expect(activateAndRevealWorktree).toHaveBeenCalledWith('wt-2');
    });
});
