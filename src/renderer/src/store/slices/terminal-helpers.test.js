import { describe, expect, it } from 'vitest';
import { emptyLayoutSnapshot, clearTransientTerminalState } from './terminal-helpers';
function makeTab(overrides = {}) {
    return {
        id: 'tab-1',
        ptyId: 'pty-123',
        worktreeId: 'wt-1',
        title: 'bash',
        customTitle: null,
        color: null,
        sortOrder: 0,
        createdAt: Date.now(),
        ...overrides
    };
}
describe('emptyLayoutSnapshot', () => {
    it('returns correct default structure', () => {
        const snapshot = emptyLayoutSnapshot();
        expect(snapshot).toEqual({
            root: null,
            activeLeafId: null,
            expandedLeafId: null
        });
    });
});
describe('clearTransientTerminalState', () => {
    it('clears ptyId to null', () => {
        const tab = makeTab({ ptyId: 'pty-abc' });
        const result = clearTransientTerminalState(tab, 0);
        expect(result.ptyId).toBeNull();
    });
    it('uses customTitle as fallback when tab has agent status in title', () => {
        const tab = makeTab({ title: '. claude', customTitle: 'My Agent' });
        const result = clearTransientTerminalState(tab, 0);
        expect(result.title).toBe('My Agent');
    });
    it('uses "Terminal {index+1}" fallback when agent status in title and no customTitle', () => {
        const tab = makeTab({ title: '. claude', customTitle: null });
        const result = clearTransientTerminalState(tab, 0);
        expect(result.title).toBe('Terminal 1');
    });
    it('prefers defaultTitle over index fallback when present', () => {
        const tab = makeTab({ title: '. claude', customTitle: null, defaultTitle: 'Terminal 4' });
        const result = clearTransientTerminalState(tab, 0);
        expect(result.title).toBe('Terminal 4');
    });
    it('keeps original title when no agent status detected', () => {
        const tab = makeTab({ title: 'bash' });
        const result = clearTransientTerminalState(tab, 0);
        expect(result.title).toBe('bash');
    });
    it('uses "Terminal {index+1}" when customTitle is whitespace only', () => {
        const tab = makeTab({ title: '⠋ codex running', customTitle: '   ' });
        const result = clearTransientTerminalState(tab, 0);
        expect(result.title).toBe('Terminal 1');
    });
    it('index-based fallback numbering: index 0 → "Terminal 1"', () => {
        const tab = makeTab({ title: '. claude', customTitle: null });
        const result = clearTransientTerminalState(tab, 0);
        expect(result.title).toBe('Terminal 1');
    });
    it('index-based fallback numbering: index 2 → "Terminal 3"', () => {
        const tab = makeTab({ title: '. claude', customTitle: null });
        const result = clearTransientTerminalState(tab, 2);
        expect(result.title).toBe('Terminal 3');
    });
});
