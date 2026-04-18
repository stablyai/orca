import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAppStore } from '@/store';
import { markLiveCodexSessionsForRestart } from './codex-session-restart';
const ACCOUNT_A = 'account-a@example.com';
const ACCOUNT_B = 'account-b@example.com';
const ACCOUNT_C = 'account-c@example.com';
describe('markLiveCodexSessionsForRestart', () => {
    const originalWindow = globalThis.window;
    beforeEach(() => {
        useAppStore.setState({
            tabsByWorktree: {
                wt1: [
                    {
                        id: 'tab-1',
                        ptyId: 'pty-1',
                        worktreeId: 'wt1',
                        title: 'orca-1',
                        customTitle: null,
                        color: null,
                        sortOrder: 0,
                        createdAt: 1
                    }
                ]
            },
            ptyIdsByTabId: {
                'tab-1': ['pty-1']
            },
            pendingCodexPaneRestartIds: {},
            codexRestartNoticeByPtyId: {},
            markCodexRestartNotices: useAppStore.getState().markCodexRestartNotices
        });
        globalThis.window = {
            ...originalWindow,
            api: {
                ...originalWindow?.api,
                pty: {
                    ...originalWindow?.api?.pty,
                    getForegroundProcess: vi.fn()
                }
            }
        };
    });
    afterEach(() => {
        if (originalWindow) {
            ;
            globalThis.window = originalWindow;
        }
        else {
            delete globalThis.window;
        }
    });
    it('marks a live Codex PTY for restart', async () => {
        vi.mocked(window.api.pty.getForegroundProcess).mockResolvedValue('codex');
        await markLiveCodexSessionsForRestart({
            previousAccountLabel: ACCOUNT_A,
            nextAccountLabel: ACCOUNT_B
        });
        expect(window.api.pty.getForegroundProcess).toHaveBeenCalledWith('pty-1');
        expect(useAppStore.getState().codexRestartNoticeByPtyId['pty-1']).toEqual({
            previousAccountLabel: ACCOUNT_A,
            nextAccountLabel: ACCOUNT_B
        });
    });
    it('does not mark non-codex foreground processes', async () => {
        vi.mocked(window.api.pty.getForegroundProcess).mockResolvedValue('zsh');
        await markLiveCodexSessionsForRestart({
            previousAccountLabel: ACCOUNT_A,
            nextAccountLabel: ACCOUNT_B
        });
        expect(useAppStore.getState().codexRestartNoticeByPtyId).toEqual({});
    });
    it('treats codex.exe as codex for Windows PTYs', async () => {
        vi.mocked(window.api.pty.getForegroundProcess).mockResolvedValue('codex.exe');
        await markLiveCodexSessionsForRestart({
            previousAccountLabel: ACCOUNT_A,
            nextAccountLabel: ACCOUNT_B
        });
        expect(useAppStore.getState().codexRestartNoticeByPtyId['pty-1']).toEqual({
            previousAccountLabel: ACCOUNT_A,
            nextAccountLabel: ACCOUNT_B
        });
    });
    it('treats codex-prefixed packaged binaries as codex', async () => {
        vi.mocked(window.api.pty.getForegroundProcess).mockResolvedValue('codex-aarch64-ap');
        await markLiveCodexSessionsForRestart({
            previousAccountLabel: ACCOUNT_A,
            nextAccountLabel: ACCOUNT_B
        });
        expect(useAppStore.getState().codexRestartNoticeByPtyId['pty-1']).toEqual({
            previousAccountLabel: ACCOUNT_A,
            nextAccountLabel: ACCOUNT_B
        });
    });
    it('clears stale restart notices when the selected account switches back to the live pane account', async () => {
        vi.mocked(window.api.pty.getForegroundProcess).mockResolvedValue('codex');
        await markLiveCodexSessionsForRestart({
            previousAccountLabel: ACCOUNT_A,
            nextAccountLabel: ACCOUNT_B
        });
        useAppStore.getState().queueCodexPaneRestarts(['pty-1']);
        await markLiveCodexSessionsForRestart({
            previousAccountLabel: ACCOUNT_B,
            nextAccountLabel: ACCOUNT_A
        });
        expect(useAppStore.getState().codexRestartNoticeByPtyId).toEqual({});
        expect(useAppStore.getState().pendingCodexPaneRestartIds).toEqual({});
    });
    it('preserves the pane original account across repeated switches until restart', async () => {
        vi.mocked(window.api.pty.getForegroundProcess).mockResolvedValue('codex');
        await markLiveCodexSessionsForRestart({
            previousAccountLabel: ACCOUNT_A,
            nextAccountLabel: ACCOUNT_B
        });
        await markLiveCodexSessionsForRestart({
            previousAccountLabel: ACCOUNT_B,
            nextAccountLabel: ACCOUNT_C
        });
        expect(useAppStore.getState().codexRestartNoticeByPtyId['pty-1']).toEqual({
            previousAccountLabel: ACCOUNT_A,
            nextAccountLabel: ACCOUNT_C
        });
    });
});
