import React from 'react';
type MarkdownPreviewProps = {
    content: string;
    filePath: string;
    scrollCacheKey: string;
};
export default function MarkdownPreview({ content, filePath, scrollCacheKey }: MarkdownPreviewProps): React.JSX.Element;
export {};
