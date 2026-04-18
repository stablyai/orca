import { jsx as _jsx } from "react/jsx-runtime";
import { useRef, useState, useEffect, useCallback } from 'react';
import { setupContextualCopy } from './setup-contextual-copy';
export function useContextualCopySetup() {
    const [copyToast, setCopyToast] = useState(null);
    const copyToastTimeoutRef = useRef(null);
    const isMac = navigator.userAgent.includes('Mac');
    const copyShortcutLabel = isMac ? '⌥⌘C' : 'Ctrl+Alt+C';
    useEffect(() => {
        const toastRef = copyToastTimeoutRef;
        return () => {
            if (toastRef.current !== null) {
                window.clearTimeout(toastRef.current);
            }
        };
    }, []);
    const setupCopy = useCallback((editorInstance, 
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    monaco, filePath, propsRef) => {
        setupContextualCopy({
            editorInstance,
            monaco,
            filePath,
            copyShortcutLabel,
            setCopyToast,
            propsRef,
            copyToastTimeoutRef
        });
    }, [copyShortcutLabel]);
    const toastNode = copyToast ? (_jsx("div", { className: "pointer-events-none fixed z-50 rounded-md bg-foreground px-2 py-1 text-xs text-background shadow-sm", style: { left: copyToast.left, top: copyToast.top }, children: "Context copied" })) : null;
    return { setupCopy, toastNode };
}
