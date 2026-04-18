import { describe, expect, it } from 'vitest';
import { isWindowShortcutModifierChord, resolveWindowShortcutAction } from './window-shortcut-policy';
describe('resolveWindowShortcutAction', () => {
    it('keeps ctrl/cmd+r and readline control chords out of the main-process allowlist', () => {
        const macCases = [
            { code: 'KeyR', key: 'r', meta: true, control: false, alt: false, shift: false },
            { code: 'KeyR', key: 'r', meta: false, control: true, alt: false, shift: false },
            { code: 'KeyU', key: 'u', meta: false, control: true, alt: false, shift: false },
            { code: 'KeyE', key: 'e', meta: false, control: true, alt: false, shift: false }
        ];
        for (const input of macCases) {
            expect(resolveWindowShortcutAction(input, 'darwin')).toBeNull();
        }
        const nonMacCases = [
            { code: 'KeyR', key: 'r', meta: false, control: true, alt: false, shift: false },
            { code: 'KeyU', key: 'u', meta: false, control: true, alt: false, shift: false },
            { code: 'KeyE', key: 'e', meta: false, control: true, alt: false, shift: false },
            { code: 'KeyJ', key: 'j', meta: false, control: true, alt: false, shift: false }
        ];
        for (const input of nonMacCases) {
            expect(resolveWindowShortcutAction(input, 'linux')).toBeNull();
        }
    });
    it('resolves the explicit window shortcut allowlist on macOS', () => {
        expect(resolveWindowShortcutAction({ code: 'KeyJ', key: 'j', meta: true, control: false, alt: false, shift: false }, 'darwin')).toEqual({ type: 'toggleWorktreePalette' });
        expect(resolveWindowShortcutAction({ code: 'KeyP', key: 'p', meta: true, control: false, alt: false, shift: false }, 'darwin')).toEqual({ type: 'openQuickOpen' });
        expect(resolveWindowShortcutAction({ code: 'Digit3', key: '3', meta: true, control: false, alt: false, shift: false }, 'darwin')).toEqual({ type: 'jumpToWorktreeIndex', index: 2 });
    });
    it('requires shift for the non-mac worktree palette shortcut', () => {
        expect(resolveWindowShortcutAction({ code: 'KeyJ', key: 'j', meta: false, control: true, alt: false, shift: false }, 'win32')).toBeNull();
        expect(resolveWindowShortcutAction({ code: 'KeyJ', key: 'j', meta: false, control: true, alt: false, shift: true }, 'win32')).toEqual({ type: 'toggleWorktreePalette' });
    });
    it('accepts all supported zoom key variants', () => {
        const zoomInCases = [
            { key: '=', meta: true, control: false, alt: false, shift: false },
            { key: '+', meta: true, control: false, alt: false, shift: true },
            { code: 'NumpadAdd', key: '', meta: true, control: false, alt: false, shift: false }
        ];
        for (const input of zoomInCases) {
            expect(resolveWindowShortcutAction(input, 'darwin')).toEqual({
                type: 'zoom',
                direction: 'in'
            });
        }
        const zoomOutCases = [
            { key: '-', meta: false, control: true, alt: false, shift: false },
            { key: '_', meta: false, control: true, alt: false, shift: true },
            { key: 'Minus', meta: false, control: true, alt: false, shift: false },
            { code: 'NumpadSubtract', key: '', meta: false, control: true, alt: false, shift: false }
        ];
        for (const input of zoomOutCases) {
            expect(resolveWindowShortcutAction(input, 'linux')).toEqual({
                type: 'zoom',
                direction: 'out'
            });
        }
        expect(resolveWindowShortcutAction({ key: '0', meta: false, control: true, alt: false, shift: false }, 'linux')).toEqual({ type: 'zoom', direction: 'reset' });
    });
    it('exposes the shared platform modifier gate used by browser guests', () => {
        expect(isWindowShortcutModifierChord({ meta: true, control: false, alt: false }, 'darwin')).toBe(true);
        expect(isWindowShortcutModifierChord({ meta: false, control: true, alt: false }, 'linux')).toBe(true);
        expect(isWindowShortcutModifierChord({ meta: false, control: true, alt: true }, 'linux')).toBe(false);
    });
});
