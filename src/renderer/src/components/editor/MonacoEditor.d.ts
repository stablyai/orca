import React from 'react';
import '@/lib/monaco-setup';
type MonacoEditorProps = {
    filePath: string;
    viewStateKey: string;
    relativePath: string;
    content: string;
    language: string;
    onContentChange: (content: string) => void;
    onSave: (content: string) => void;
    revealLine?: number;
    revealColumn?: number;
    revealMatchLength?: number;
};
export default function MonacoEditor({ filePath, viewStateKey, relativePath, content, language, onContentChange, onSave, revealLine, revealColumn, revealMatchLength }: MonacoEditorProps): React.JSX.Element;
export {};
