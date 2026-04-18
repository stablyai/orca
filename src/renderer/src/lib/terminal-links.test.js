import { describe, expect, it } from 'vitest';
import { isPathInsideWorktree, resolveTerminalFileLink, toWorktreeRelativePath } from './terminal-links';
describe('terminal path helpers', () => {
    it('keeps worktree-relative paths on Windows external files', () => {
        expect(isPathInsideWorktree('C:\\repo\\src\\file.ts', 'C:\\repo')).toBe(true);
        expect(toWorktreeRelativePath('C:\\repo\\src\\file.ts', 'C:\\repo')).toBe('src/file.ts');
    });
    it('supports Windows cwd resolution for terminal file links', () => {
        expect(resolveTerminalFileLink({
            pathText: '.\\src\\file.ts',
            line: 12,
            column: 3,
            startIndex: 0,
            endIndex: 13,
            displayText: '.\\src\\file.ts:12:3'
        }, 'C:\\repo')).toEqual({
            absolutePath: 'C:/repo/src/file.ts',
            line: 12,
            column: 3
        });
    });
});
