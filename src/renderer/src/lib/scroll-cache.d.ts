import type { editor } from 'monaco-editor';
export declare function setWithLRU<K, V>(map: Map<K, V>, key: K, value: V, maxEntries?: number): void;
export declare const scrollTopCache: Map<string, number>;
export declare const cursorPositionCache: Map<string, {
    lineNumber: number;
    column: number;
}>;
export declare const diffViewStateCache: Map<string, editor.IDiffEditorViewState>;
