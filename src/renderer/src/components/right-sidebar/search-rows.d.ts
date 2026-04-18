import type { SearchFileResult, SearchMatch, SearchResult } from '../../../../shared/types';
export type SearchRow = {
    type: 'file';
    fileResult: SearchFileResult;
    collapsed: boolean;
} | {
    type: 'match';
    fileResult: SearchFileResult;
    match: SearchMatch;
    matchIndex: number;
};
export declare function buildSearchRows(results: SearchResult | null, collapsedFiles: ReadonlySet<string>): SearchRow[];
