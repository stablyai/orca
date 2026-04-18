import { describe, expect, it } from 'vitest';
import { countWorkingAgents, getWorkingAgentsPerWorktree } from './agent-status';
function makeTab(overrides = {}) {
    return {
        id: 'tab-1',
        ptyId: 'pty-1',
        worktreeId: 'wt-1',
        title: 'Terminal 1',
        customTitle: null,
        color: null,
        sortOrder: 0,
        createdAt: 0,
        ...overrides
    };
}
function worktrees(...ids) {
    return {
        repo: ids.map((id) => ({
            id,
            repoId: 'repo',
            path: `/path/${id}`,
            head: '',
            branch: '',
            isBare: false,
            isMainWorktree: false,
            displayName: id,
            comment: '',
            linkedIssue: null,
            linkedPR: null,
            isArchived: false,
            isUnread: false,
            isPinned: false,
            sortOrder: 0,
            lastActivityAt: 0
        }))
    };
}
describe('countWorkingAgents', () => {
    it('counts each live working tab when pane-level titles are unavailable', () => {
        expect(countWorkingAgents({
            tabsByWorktree: {
                'wt-1': [
                    makeTab({ id: 'tab-1', title: '⠂ Claude Code' }),
                    makeTab({ id: 'tab-2', title: '✦ Gemini CLI' })
                ],
                'wt-2': [makeTab({ id: 'tab-3', worktreeId: 'wt-2', title: '⠋ Codex is thinking' })]
            },
            runtimePaneTitlesByTabId: {},
            worktreesByRepo: worktrees('wt-1', 'wt-2')
        })).toBe(3);
    });
    it('counts working panes separately within the same tab', () => {
        expect(countWorkingAgents({
            tabsByWorktree: {
                'wt-1': [makeTab({ id: 'tab-1', title: '⠂ Claude Code' })]
            },
            runtimePaneTitlesByTabId: {
                'tab-1': {
                    1: '⠂ Claude Code',
                    2: '✦ Gemini CLI',
                    3: '✳ Claude Code'
                }
            },
            worktreesByRepo: worktrees('wt-1')
        })).toBe(2);
    });
    it('ignores non-working or non-live tabs', () => {
        expect(countWorkingAgents({
            tabsByWorktree: {
                'wt-1': [
                    makeTab({ id: 'tab-1', title: '✳ Claude Code' }),
                    makeTab({ id: 'tab-2', title: '✋ Gemini CLI' }),
                    makeTab({ id: 'tab-3', title: 'bash' }),
                    makeTab({ id: 'tab-4', title: '⠂ Claude Code', ptyId: null })
                ]
            },
            runtimePaneTitlesByTabId: {},
            worktreesByRepo: worktrees('wt-1')
        })).toBe(0);
    });
    it('prefers pane-level titles over the coarse tab title when available', () => {
        expect(countWorkingAgents({
            tabsByWorktree: {
                'wt-1': [makeTab({ id: 'tab-1', title: '⠂ Claude Code' })]
            },
            runtimePaneTitlesByTabId: {
                'tab-1': {
                    1: '✳ Claude Code',
                    2: 'bash'
                }
            },
            worktreesByRepo: worktrees('wt-1')
        })).toBe(0);
    });
    it('excludes orphaned worktrees not in worktreesByRepo', () => {
        expect(countWorkingAgents({
            tabsByWorktree: {
                'wt-1': [makeTab({ id: 'tab-1', title: '⠂ Claude Code' })],
                'wt-deleted': [makeTab({ id: 'tab-2', worktreeId: 'wt-deleted', title: '✦ Gemini CLI' })]
            },
            runtimePaneTitlesByTabId: {},
            worktreesByRepo: worktrees('wt-1')
        })).toBe(1);
    });
});
describe('getWorkingAgentsPerWorktree', () => {
    it('returns per-pane labels and pane ids for split tabs', () => {
        expect(getWorkingAgentsPerWorktree({
            tabsByWorktree: {
                'wt-1': [makeTab({ id: 'tab-1', title: '⠂ Claude Code' })]
            },
            runtimePaneTitlesByTabId: {
                'tab-1': {
                    1: '⠂ Claude Code',
                    2: '✦ Gemini CLI',
                    3: '✳ Claude Code'
                }
            },
            worktreesByRepo: worktrees('wt-1')
        })).toEqual({
            'wt-1': {
                agents: [
                    { label: 'Claude Code', status: 'working', tabId: 'tab-1', paneId: 1 },
                    { label: 'Gemini CLI', status: 'working', tabId: 'tab-1', paneId: 2 }
                ]
            }
        });
    });
    it('excludes orphaned worktrees not in worktreesByRepo', () => {
        expect(getWorkingAgentsPerWorktree({
            tabsByWorktree: {
                'wt-1': [makeTab({ id: 'tab-1', title: '⠂ Claude Code' })],
                'wt-deleted': [makeTab({ id: 'tab-2', worktreeId: 'wt-deleted', title: '✦ Gemini CLI' })]
            },
            runtimePaneTitlesByTabId: {},
            worktreesByRepo: worktrees('wt-1')
        })).toEqual({
            'wt-1': {
                agents: [{ label: 'Claude Code', status: 'working', tabId: 'tab-1', paneId: null }]
            }
        });
    });
});
