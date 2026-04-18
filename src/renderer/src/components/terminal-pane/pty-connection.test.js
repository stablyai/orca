import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const scheduleRuntimeGraphSync = vi.fn();
const shouldSeedCacheTimerOnInitialTitle = vi.fn(() => false);
let mockStoreState;
let transportFactoryQueue = [];
let createdTransportOptions = [];
vi.mock('@/runtime/sync-runtime-graph', () => ({
    scheduleRuntimeGraphSync
}));
vi.mock('@/store', () => ({
    useAppStore: {
        getState: () => mockStoreState
    }
}));
vi.mock('@/lib/agent-status', () => ({
    isGeminiTerminalTitle: vi.fn(() => false),
    isClaudeAgent: vi.fn(() => false)
}));
vi.mock('./cache-timer-seeding', () => ({
    shouldSeedCacheTimerOnInitialTitle
}));
vi.mock('./pty-transport', () => ({
    createIpcPtyTransport: vi.fn((options) => {
        createdTransportOptions.push(options);
        const nextTransport = transportFactoryQueue.shift();
        if (!nextTransport) {
            throw new Error('No mock transport queued');
        }
        return nextTransport;
    })
}));
function createMockTransport(initialPtyId = null) {
    let ptyId = initialPtyId;
    return {
        attach: vi.fn(({ existingPtyId }) => {
            ptyId = existingPtyId;
        }),
        connect: vi.fn().mockImplementation(async (opts) => {
            if (opts.sessionId) {
                ptyId = opts.sessionId;
                return { id: opts.sessionId };
            }
            return ptyId;
        }),
        sendInput: vi.fn(() => true),
        resize: vi.fn(() => true),
        getPtyId: vi.fn(() => ptyId)
    };
}
function createPane(paneId) {
    return {
        id: paneId,
        terminal: {
            cols: 120,
            rows: 40,
            write: vi.fn(),
            onData: vi.fn(() => ({ dispose: vi.fn() })),
            onResize: vi.fn(() => ({ dispose: vi.fn() }))
        },
        fitAddon: {
            fit: vi.fn()
        }
    };
}
function createManager(paneCount = 1) {
    return {
        setPaneGpuRendering: vi.fn(),
        getPanes: vi.fn(() => Array.from({ length: paneCount }, (_, index) => ({ id: index + 1 }))),
        closePane: vi.fn()
    };
}
function createDeps(overrides = {}) {
    return {
        tabId: 'tab-1',
        worktreeId: 'wt-1',
        cwd: '/tmp/wt-1',
        startup: null,
        restoredLeafId: null,
        restoredPtyIdByLeafId: {},
        paneTransportsRef: { current: new Map() },
        pendingWritesRef: { current: new Map() },
        isActiveRef: { current: true },
        isVisibleRef: { current: true },
        onPtyExitRef: { current: vi.fn() },
        onPtyErrorRef: { current: vi.fn() },
        clearTabPtyId: vi.fn(),
        consumeSuppressedPtyExit: vi.fn(() => false),
        updateTabTitle: vi.fn(),
        setRuntimePaneTitle: vi.fn(),
        clearRuntimePaneTitle: vi.fn(),
        updateTabPtyId: vi.fn(),
        markWorktreeUnread: vi.fn(),
        dispatchNotification: vi.fn(),
        setCacheTimerStartedAt: vi.fn(),
        syncPanePtyLayoutBinding: vi.fn(),
        ...overrides
    };
}
describe('connectPanePty', () => {
    const originalRequestAnimationFrame = globalThis.requestAnimationFrame;
    const originalCancelAnimationFrame = globalThis.cancelAnimationFrame;
    beforeEach(() => {
        vi.resetModules();
        vi.clearAllMocks();
        transportFactoryQueue = [];
        createdTransportOptions = [];
        mockStoreState = {
            tabsByWorktree: {
                'wt-1': [{ id: 'tab-1', ptyId: 'tab-pty' }]
            },
            worktreesByRepo: {
                repo1: [{ id: 'wt-1', repoId: 'repo1', path: '/tmp/wt-1' }]
            },
            repos: [{ id: 'repo1', connectionId: null }],
            cacheTimerByKey: {},
            settings: { promptCacheTimerEnabled: true },
            consumePendingColdRestore: vi.fn(() => null),
            consumePendingSnapshot: vi.fn(() => null)
        };
        globalThis.requestAnimationFrame = vi.fn((callback) => {
            callback(0);
            return 1;
        });
        globalThis.cancelAnimationFrame = vi.fn();
    });
    afterEach(() => {
        if (originalRequestAnimationFrame) {
            globalThis.requestAnimationFrame = originalRequestAnimationFrame;
        }
        else {
            delete globalThis
                .requestAnimationFrame;
        }
        if (originalCancelAnimationFrame) {
            globalThis.cancelAnimationFrame = originalCancelAnimationFrame;
        }
        else {
            delete globalThis
                .cancelAnimationFrame;
        }
    });
    it('does not send startup command via sendInput for local connections', async () => {
        // Why: the local PTY provider already writes the command via
        // writeStartupCommandWhenShellReady — sending it again from the renderer
        // would cause the command to appear twice in the terminal.
        const { connectPanePty } = await import('./pty-connection');
        const capturedDataCallback = { current: null };
        const transport = createMockTransport();
        transport.connect.mockImplementation(async ({ callbacks }) => {
            capturedDataCallback.current = callbacks.onData ?? null;
            return 'pty-local-1';
        });
        transportFactoryQueue.push(transport);
        // Local connection: no connectionId
        mockStoreState = {
            ...mockStoreState,
            tabsByWorktree: { 'wt-1': [{ id: 'tab-1', ptyId: null }] },
            repos: [{ id: 'repo1', connectionId: null }]
        };
        const pane = createPane(1);
        const manager = createManager(1);
        const deps = createDeps({ startup: { command: "claude 'say test'" } });
        connectPanePty(pane, manager, deps);
        expect(capturedDataCallback.current).not.toBeNull();
        // Simulate PTY output (shell prompt arriving)
        capturedDataCallback.current?.('(base) user@host $ ');
        // Even after the debounce window, the renderer must not inject the command
        // because the main process already wrote it via writeStartupCommandWhenShellReady.
        expect(transport.sendInput).not.toHaveBeenCalledWith(expect.stringContaining("claude 'say test'"));
    });
    it('sends startup command via sendInput for SSH connections (relay has no shell-ready mechanism)', async () => {
        // Capture the setTimeout callback directly so we can fire it without
        // vi.useFakeTimers() (which would also replace the rAF mock from beforeEach).
        const pendingTimeouts = [];
        const originalSetTimeout = globalThis.setTimeout;
        globalThis.setTimeout = vi.fn((fn) => {
            pendingTimeouts.push(fn);
            return 999;
        });
        try {
            const { connectPanePty } = await import('./pty-connection');
            const capturedDataCallback = {
                current: null
            };
            const transport = createMockTransport();
            transport.connect.mockImplementation(async ({ callbacks }) => {
                capturedDataCallback.current = callbacks.onData ?? null;
                return 'pty-ssh-1';
            });
            transportFactoryQueue.push(transport);
            // SSH connection: connectionId is set, relay ignores the command field
            mockStoreState = {
                ...mockStoreState,
                tabsByWorktree: { 'wt-1': [{ id: 'tab-1', ptyId: null }] },
                repos: [{ id: 'repo1', connectionId: 'ssh-conn-1' }]
            };
            const pane = createPane(1);
            const manager = createManager(1);
            const deps = createDeps({ startup: { command: "claude 'say test'" } });
            connectPanePty(pane, manager, deps);
            expect(capturedDataCallback.current).not.toBeNull();
            // Simulate shell prompt arriving — queues the debounce timer
            capturedDataCallback.current?.('user@remote $ ');
            // Fire all queued setTimeout callbacks (the debounce)
            for (const fn of pendingTimeouts) {
                fn();
            }
            expect(transport.sendInput).toHaveBeenCalledWith("claude 'say test'\r");
        }
        finally {
            globalThis.setTimeout = originalSetTimeout;
        }
    });
    it('reattaches a remounted split pane to its restored leaf PTY instead of the tab-level PTY', async () => {
        const { connectPanePty } = await import('./pty-connection');
        const transport = createMockTransport();
        transportFactoryQueue.push(transport);
        const pane = createPane(2);
        const manager = createManager(2);
        const deps = createDeps({
            restoredLeafId: 'pane:2',
            restoredPtyIdByLeafId: { 'pane:2': 'leaf-pty-2' }
        });
        connectPanePty(pane, manager, deps);
        // Why: Option 2 deferred reattach uses connect({ sessionId }) instead of
        // attach({ existingPtyId }) so the daemon's createOrAttach runs at the
        // pane's real fitAddon dimensions.
        expect(transport.connect).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'leaf-pty-2' }));
        expect(transport.attach).not.toHaveBeenCalled();
        await Promise.resolve();
        expect(deps.syncPanePtyLayoutBinding).toHaveBeenCalledWith(2, 'leaf-pty-2');
    });
    it('persists a restarted pane PTY id and uses it on the next remount', async () => {
        const { connectPanePty } = await import('./pty-connection');
        const restartedTransport = createMockTransport();
        let spawnedPtyId = null;
        restartedTransport.connect.mockImplementation(async () => {
            spawnedPtyId = 'pty-restarted';
            const opts = createdTransportOptions[0];
            opts.onPtySpawn('pty-restarted');
            return 'pty-restarted';
        });
        transportFactoryQueue.push(restartedTransport);
        const restartPane = createPane(1);
        const restartManager = createManager(1);
        const restartDeps = createDeps({
            paneTransportsRef: { current: new Map([[99, createMockTransport('another-pane-pty')]]) }
        });
        connectPanePty(restartPane, restartManager, restartDeps);
        await Promise.resolve();
        expect(spawnedPtyId).toBe('pty-restarted');
        expect(restartDeps.syncPanePtyLayoutBinding).toHaveBeenCalledWith(1, 'pty-restarted');
        mockStoreState = {
            ...mockStoreState,
            tabsByWorktree: {
                'wt-1': [{ id: 'tab-1', ptyId: 'pty-restarted' }]
            }
        };
        const remountTransport = createMockTransport();
        transportFactoryQueue.push(remountTransport);
        const remountPane = createPane(1);
        const remountManager = createManager(1);
        const remountDeps = createDeps({
            restoredLeafId: 'pane:1',
            restoredPtyIdByLeafId: { 'pane:1': 'pty-restarted' }
        });
        connectPanePty(remountPane, remountManager, remountDeps);
        expect(remountTransport.connect).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'pty-restarted' }));
        expect(remountTransport.attach).not.toHaveBeenCalled();
        await Promise.resolve();
        expect(remountDeps.syncPanePtyLayoutBinding).toHaveBeenCalledWith(1, 'pty-restarted');
    });
});
