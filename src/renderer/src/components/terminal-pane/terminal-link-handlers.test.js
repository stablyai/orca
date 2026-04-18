import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { handleOscLink, isTerminalLinkActivation } from './terminal-link-handlers';
const openUrlMock = vi.fn();
const openFileUriMock = vi.fn();
const openFileMock = vi.fn();
const authorizeExternalPathMock = vi.fn();
const statMock = vi.fn().mockResolvedValue({ isDirectory: false });
const setActiveWorktreeMock = vi.fn();
const createBrowserTabMock = vi.fn();
const deps = { worktreeId: 'wt-1', worktreePath: '/tmp' };
const storeState = {
    settings: undefined,
    setActiveWorktree: setActiveWorktreeMock,
    createBrowserTab: createBrowserTabMock,
    openFile: openFileMock
};
vi.mock('@/store', () => ({
    useAppStore: {
        getState: () => storeState
    }
}));
vi.mock('@/lib/language-detect', () => ({
    detectLanguage: () => 'plaintext'
}));
function setPlatform(userAgent) {
    vi.stubGlobal('navigator', { userAgent });
}
beforeEach(() => {
    vi.clearAllMocks();
    storeState.settings = undefined;
    vi.stubGlobal('window', {
        api: {
            shell: {
                openUrl: openUrlMock,
                openFileUri: openFileUriMock
            },
            fs: {
                authorizeExternalPath: authorizeExternalPathMock,
                stat: statMock
            }
        }
    });
});
afterEach(() => {
    vi.unstubAllGlobals();
});
describe('isTerminalLinkActivation', () => {
    it('requires cmd on macOS', () => {
        setPlatform('Macintosh');
        expect(isTerminalLinkActivation({ metaKey: true, ctrlKey: false })).toBe(true);
        expect(isTerminalLinkActivation({ metaKey: false, ctrlKey: true })).toBe(false);
        expect(isTerminalLinkActivation(undefined)).toBe(false);
    });
    it('requires ctrl on non-macOS platforms', () => {
        setPlatform('Windows');
        expect(isTerminalLinkActivation({ metaKey: false, ctrlKey: true })).toBe(true);
        expect(isTerminalLinkActivation({ metaKey: true, ctrlKey: false })).toBe(false);
        expect(isTerminalLinkActivation(undefined)).toBe(false);
    });
});
describe('handleOscLink', () => {
    it('ignores http links without the platform modifier', () => {
        setPlatform('Macintosh');
        handleOscLink('https://example.com', { metaKey: false, ctrlKey: false }, deps);
        expect(openUrlMock).not.toHaveBeenCalled();
    });
    it('routes to the system browser when openLinksInApp is off', () => {
        setPlatform('Macintosh');
        storeState.settings = { openLinksInApp: false };
        const preventDefault = vi.fn();
        const stopPropagation = vi.fn();
        handleOscLink('https://example.com', { metaKey: true, ctrlKey: false, shiftKey: false, preventDefault, stopPropagation }, deps);
        expect(openUrlMock).toHaveBeenCalledWith('https://example.com/');
        expect(createBrowserTabMock).not.toHaveBeenCalled();
        expect(preventDefault).toHaveBeenCalled();
        expect(stopPropagation).toHaveBeenCalled();
    });
    it('defaults to Orca when settings have not hydrated yet', () => {
        setPlatform('Macintosh');
        storeState.settings = undefined;
        handleOscLink('https://example.com', { metaKey: true, ctrlKey: false, shiftKey: false }, deps);
        expect(createBrowserTabMock).toHaveBeenCalledWith('wt-1', 'https://example.com/');
        expect(openUrlMock).not.toHaveBeenCalled();
    });
    it('uses the system browser for shift+cmd/ctrl+click even when Orca browser tabs are enabled', () => {
        setPlatform('Windows');
        storeState.settings = { openLinksInApp: true };
        handleOscLink('https://example.com', { metaKey: false, ctrlKey: true, shiftKey: true }, deps);
        expect(openUrlMock).toHaveBeenCalledWith('https://example.com/');
        expect(createBrowserTabMock).not.toHaveBeenCalled();
    });
    it('falls back to the system browser when no worktree owns the terminal pane', () => {
        setPlatform('Macintosh');
        storeState.settings = { openLinksInApp: true };
        handleOscLink('https://example.com', { metaKey: true, ctrlKey: false, shiftKey: false }, { worktreeId: '', worktreePath: '/tmp' });
        expect(openUrlMock).toHaveBeenCalledWith('https://example.com/');
        expect(createBrowserTabMock).not.toHaveBeenCalled();
    });
    it('opens file links in Orca instead of via shell when the platform modifier is pressed', async () => {
        setPlatform('Windows');
        handleOscLink('file:///tmp/test.txt', { metaKey: false, ctrlKey: false }, deps);
        // Without modifier, nothing happens
        expect(openFileUriMock).not.toHaveBeenCalled();
        handleOscLink('file:///tmp/test.txt', { metaKey: false, ctrlKey: true }, deps);
        // Should NOT call shell.openFileUri (which opens system default editor)
        expect(openFileUriMock).not.toHaveBeenCalled();
        // openDetectedFilePath is async (fire-and-forget), so flush the microtask queue
        // before asserting on positive behavior.
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(authorizeExternalPathMock).toHaveBeenCalledWith({ targetPath: '/tmp/test.txt' });
        expect(openFileMock).toHaveBeenCalledWith(expect.objectContaining({ filePath: '/tmp/test.txt' }));
    });
});
