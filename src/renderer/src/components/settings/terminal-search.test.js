import { describe, expect, it } from 'vitest';
import { getTerminalPaneSearchEntries } from './terminal-search';
describe('getTerminalPaneSearchEntries', () => {
    it('includes the Windows right-click setting on Windows', () => {
        const entries = getTerminalPaneSearchEntries({ isWindows: true, isMac: false });
        expect(entries.some((entry) => entry.title === 'Right-click to paste')).toBe(true);
    });
    it('omits the Windows right-click setting elsewhere', () => {
        const entries = getTerminalPaneSearchEntries({ isWindows: false, isMac: false });
        expect(entries.some((entry) => entry.title === 'Right-click to paste')).toBe(false);
    });
    it('includes the Option as Alt setting on macOS', () => {
        const entries = getTerminalPaneSearchEntries({ isWindows: false, isMac: true });
        expect(entries.some((entry) => entry.title === 'Option as Alt')).toBe(true);
    });
    it('omits the Option as Alt setting on non-macOS', () => {
        const entries = getTerminalPaneSearchEntries({ isWindows: false, isMac: false });
        expect(entries.some((entry) => entry.title === 'Option as Alt')).toBe(false);
    });
});
