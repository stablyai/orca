import { describe, expect, it } from 'vitest';
import { isWindowsUserAgent, shellEscapePath } from './pane-helpers';
describe('isWindowsUserAgent', () => {
    it('detects Windows user agents', () => {
        expect(isWindowsUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64)')).toBe(true);
    });
    it('ignores non-Windows user agents', () => {
        expect(isWindowsUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)')).toBe(false);
    });
});
describe('shellEscapePath', () => {
    it('keeps safe POSIX paths unquoted', () => {
        expect(shellEscapePath('/tmp/file.txt', 'Macintosh')).toBe('/tmp/file.txt');
    });
    it('single-quotes POSIX paths with shell-special characters', () => {
        expect(shellEscapePath("/tmp/it's here.txt", 'Linux')).toBe("'/tmp/it'\\''s here.txt'");
    });
    it('keeps safe Windows paths unquoted', () => {
        expect(shellEscapePath('C:\\Users\\orca\\file.txt', 'Windows')).toBe('C:\\Users\\orca\\file.txt');
    });
    it('double-quotes Windows paths with spaces', () => {
        expect(shellEscapePath('C:\\Users\\orca\\my file.txt', 'Windows')).toBe('"C:\\Users\\orca\\my file.txt"');
    });
    it('double-quotes Windows paths with cmd separators', () => {
        expect(shellEscapePath('C:\\Users\\orca\\a&b.txt', 'Windows')).toBe('"C:\\Users\\orca\\a&b.txt"');
    });
});
