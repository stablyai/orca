import { beforeEach, describe, expect, it, vi } from 'vitest';
describe('useModifierHint helpers', () => {
    beforeEach(() => {
        vi.resetModules();
        vi.unstubAllGlobals();
    });
    it('starts the timer only for the bare platform modifier', async () => {
        vi.stubGlobal('navigator', { userAgent: 'Macintosh' });
        const { shouldStartModifierHintTimer } = await import('./useModifierHint');
        expect(shouldStartModifierHintTimer({
            key: 'Meta',
            altKey: false,
            shiftKey: false,
            ctrlKey: false,
            metaKey: true,
            repeat: false
        })).toBe(true);
        expect(shouldStartModifierHintTimer({
            key: 'Meta',
            altKey: false,
            shiftKey: true,
            ctrlKey: false,
            metaKey: true,
            repeat: false
        })).toBe(false);
        expect(shouldStartModifierHintTimer({
            key: 'b',
            altKey: false,
            shiftKey: false,
            ctrlKey: false,
            metaKey: true,
            repeat: false
        })).toBe(false);
    });
    it('clears when the shortcut key is released while the modifier is still held', async () => {
        vi.stubGlobal('navigator', { userAgent: 'Macintosh' });
        const { shouldClearModifierHintOnKeyUp } = await import('./useModifierHint');
        expect(shouldClearModifierHintOnKeyUp({
            key: 'b',
            ctrlKey: false,
            metaKey: true
        })).toBe(true);
        expect(shouldClearModifierHintOnKeyUp({
            key: 'Meta',
            ctrlKey: false,
            metaKey: false
        })).toBe(true);
        expect(shouldClearModifierHintOnKeyUp({
            key: 'b',
            ctrlKey: false,
            metaKey: false
        })).toBe(false);
    });
});
