import React from 'react';
import '@/lib/monaco-setup';
type DiffViewerProps = {
    modelKey: string;
    originalContent: string;
    modifiedContent: string;
    language: string;
    filePath: string;
    relativePath: string;
    sideBySide: boolean;
    editable?: boolean;
    onContentChange?: (content: string) => void;
    onSave?: (content: string) => void;
};
export default function DiffViewer({ modelKey, originalContent, modifiedContent, language, filePath, relativePath, sideBySide, editable, onContentChange, onSave }: DiffViewerProps): React.JSX.Element;
export {};
