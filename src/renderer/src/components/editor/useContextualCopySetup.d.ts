import React from 'react';
import type { editor } from 'monaco-editor';
export declare function useContextualCopySetup(): {
    setupCopy: (editorInstance: editor.IStandaloneCodeEditor, monaco: any, filePath: string, propsRef: React.MutableRefObject<{
        relativePath: string;
        language: string;
        onSave?: (content: string) => void;
    }>) => void;
    toastNode: import("react/jsx-runtime").JSX.Element | null;
};
