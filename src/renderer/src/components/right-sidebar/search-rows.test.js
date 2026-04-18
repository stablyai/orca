import { describe, expect, it } from 'vitest';
import { buildSearchRows } from './search-rows';
describe('buildSearchRows', () => {
    it('includes file headers and expanded matches in row order (summary is rendered separately)', () => {
        const rows = buildSearchRows({
            totalMatches: 3,
            truncated: false,
            files: [
                {
                    filePath: '/repo/a.ts',
                    relativePath: 'a.ts',
                    matches: [
                        { line: 1, column: 1, matchLength: 3, lineContent: 'foo' },
                        { line: 2, column: 5, matchLength: 3, lineContent: 'bar foo' }
                    ]
                },
                {
                    filePath: '/repo/b.ts',
                    relativePath: 'nested/b.ts',
                    matches: [{ line: 8, column: 2, matchLength: 3, lineContent: ' foo' }]
                }
            ]
        }, new Set());
        expect(rows.map((row) => row.type)).toEqual(['file', 'match', 'match', 'file', 'match']);
    });
    it('omits match rows for collapsed files', () => {
        const rows = buildSearchRows({
            totalMatches: 2,
            truncated: true,
            files: [
                {
                    filePath: '/repo/a.ts',
                    relativePath: 'a.ts',
                    matches: [{ line: 1, column: 1, matchLength: 3, lineContent: 'foo' }]
                },
                {
                    filePath: '/repo/b.ts',
                    relativePath: 'b.ts',
                    matches: [{ line: 2, column: 1, matchLength: 3, lineContent: 'foo' }]
                }
            ]
        }, new Set(['/repo/a.ts']));
        expect(rows.map((row) => row.type)).toEqual(['file', 'file', 'match']);
    });
});
