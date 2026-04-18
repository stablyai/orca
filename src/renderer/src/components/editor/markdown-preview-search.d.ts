export declare function isMarkdownPreviewFindShortcut(event: Pick<KeyboardEvent, 'key' | 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey'>, isMac: boolean): boolean;
export declare function findTextMatchRanges(text: string, query: string): {
    start: number;
    end: number;
}[];
export declare function clearMarkdownPreviewSearchHighlights(root: HTMLElement): void;
export declare function applyMarkdownPreviewSearchHighlights(root: HTMLElement, query: string): HTMLElement[];
export declare function setActiveMarkdownPreviewSearchMatch(matches: readonly HTMLElement[], activeIndex: number): void;
