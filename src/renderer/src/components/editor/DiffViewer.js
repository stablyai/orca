import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useCallback, useLayoutEffect, useRef } from 'react';
import { DiffEditor } from '@monaco-editor/react';
import { useAppStore } from '@/store';
import { diffViewStateCache, setWithLRU } from '@/lib/scroll-cache';
import '@/lib/monaco-setup';
import { computeEditorFontSize } from '@/lib/editor-font-zoom';
import { useContextualCopySetup } from './useContextualCopySetup';
export default function DiffViewer({ modelKey, originalContent, modifiedContent, language, filePath, relativePath, sideBySide, editable, onContentChange, onSave }) {
    const settings = useAppStore((s) => s.settings);
    const editorFontZoomLevel = useAppStore((s) => s.editorFontZoomLevel);
    const editorFontSize = computeEditorFontSize(settings?.terminalFontSize ?? 13, editorFontZoomLevel);
    const isDark = settings?.theme === 'dark' ||
        (settings?.theme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
    const diffEditorRef = useRef(null);
    // Keep refs to latest callbacks so the mounted editor always calls current versions
    const onSaveRef = useRef(onSave);
    onSaveRef.current = onSave;
    const onContentChangeRef = useRef(onContentChange);
    onContentChangeRef.current = onContentChange;
    const { setupCopy, toastNode } = useContextualCopySetup();
    const propsRef = useRef({ relativePath, language, onSave });
    propsRef.current = { relativePath, language, onSave };
    const handleMount = useCallback((diffEditor, monaco) => {
        diffEditorRef.current = diffEditor;
        const originalEditor = diffEditor.getOriginalEditor();
        const modifiedEditor = diffEditor.getModifiedEditor();
        setupCopy(originalEditor, monaco, filePath, propsRef);
        setupCopy(modifiedEditor, monaco, filePath, propsRef);
        // Why: restoring the full diff view state matches VS Code more closely
        // than replaying scrollTop alone, and avoids divergent cursor/selection
        // state between the original and modified panes.
        const savedViewState = diffViewStateCache.get(modelKey);
        if (savedViewState) {
            requestAnimationFrame(() => diffEditor.restoreViewState(savedViewState));
        }
        if (editable) {
            // Cmd/Ctrl+S to save
            modifiedEditor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
                onSaveRef.current?.(modifiedEditor.getValue());
            });
            // Track changes
            modifiedEditor.onDidChangeModelContent(() => {
                onContentChangeRef.current?.(modifiedEditor.getValue());
            });
            modifiedEditor.focus();
        }
        else {
            diffEditor.focus();
        }
    }, [editable, setupCopy, modelKey, filePath]);
    // Why: VS Code snapshots diff view state on deactivation, not on scroll events.
    // The useLayoutEffect cleanup fires synchronously before React unmounts the
    // component on tab switch, which is Orca's equivalent of VS Code's clearInput().
    useLayoutEffect(() => {
        return () => {
            const de = diffEditorRef.current;
            if (de) {
                const currentViewState = de.saveViewState();
                if (currentViewState) {
                    setWithLRU(diffViewStateCache, modelKey, currentViewState);
                }
            }
        };
    }, [modelKey]);
    return (_jsxs("div", { className: "flex flex-col flex-1 min-h-0", children: [_jsx("div", { className: "flex-1 min-h-0", children: _jsx(DiffEditor, { height: "100%", language: language, original: originalContent, modified: modifiedContent, theme: isDark ? 'vs-dark' : 'vs', onMount: handleMount, 
                    // Why: A single file can have multiple live diff tabs at once
                    // (staged, unstaged, branch compare versions). The kept Monaco models
                    // must therefore key off the tab identity, not the raw file path, or
                    // one diff tab can incorrectly reuse another tab's model contents.
                    originalModelPath: `diff:original:${modelKey}`, modifiedModelPath: `diff:modified:${modelKey}`, keepCurrentOriginalModel: true, keepCurrentModifiedModel: true, options: {
                        readOnly: !editable,
                        originalEditable: false,
                        renderSideBySide: sideBySide,
                        minimap: { enabled: false },
                        scrollBeyondLastLine: false,
                        fontSize: editorFontSize,
                        fontFamily: settings?.terminalFontFamily || 'monospace',
                        lineNumbers: 'on',
                        automaticLayout: true,
                        renderOverviewRuler: true,
                        padding: { top: 0 },
                        find: {
                            addExtraSpaceOnTop: false,
                            autoFindInSelection: 'never',
                            seedSearchStringFromSelection: 'never'
                        }
                    } }) }), toastNode] }));
}
