export type MarkdownRichModeUnsupportedReason = 'html-or-jsx' | 'reference-links' | 'footnotes' | 'other';
export declare function getMarkdownRichModeUnsupportedMessage(content: string): string | null;
