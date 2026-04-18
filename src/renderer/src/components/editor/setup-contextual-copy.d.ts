import type { editor } from 'monaco-editor';
export declare function setupContextualCopy({ editorInstance, monaco, filePath, copyShortcutLabel, setCopyToast, propsRef, copyToastTimeoutRef }: {
    editorInstance: editor.IStandaloneCodeEditor;
    monaco: any;
    filePath: string;
    copyShortcutLabel: string;
    setCopyToast: (toast: {
        left: number;
        top: number;
    } | null) => void;
    propsRef: React.MutableRefObject<{
        relativePath: string;
        language: string;
        onSave?: (content: string) => void;
    }>;
    copyToastTimeoutRef: React.MutableRefObject<number | null>;
}): void;
