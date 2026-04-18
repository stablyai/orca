type MarkdownViewMode = 'source' | 'rich';
export type MarkdownRenderMode = 'source' | 'rich-editor' | 'preview';
export declare function getMarkdownRenderMode({ exceedsRichModeSizeLimit, hasRichModeUnsupportedContent, viewMode }: {
    exceedsRichModeSizeLimit: boolean;
    hasRichModeUnsupportedContent: boolean;
    viewMode: MarkdownViewMode;
}): MarkdownRenderMode;
export {};
