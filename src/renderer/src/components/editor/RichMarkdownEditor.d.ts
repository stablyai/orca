import React from 'react';
type RichMarkdownEditorProps = {
    fileId: string;
    content: string;
    filePath: string;
    scrollCacheKey: string;
    onContentChange: (content: string) => void;
    onDirtyStateHint: (dirty: boolean) => void;
    onSave: (content: string) => void;
};
export default function RichMarkdownEditor({ fileId, content, filePath, scrollCacheKey, onContentChange, onDirtyStateHint, onSave }: RichMarkdownEditorProps): React.JSX.Element;
export {};
