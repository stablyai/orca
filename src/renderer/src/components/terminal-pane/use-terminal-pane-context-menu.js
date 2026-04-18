import { useEffect, useRef, useState } from 'react';
const CLOSE_ALL_CONTEXT_MENUS_EVENT = 'orca-close-all-context-menus';
export function useTerminalPaneContextMenu({ managerRef, toggleExpandPane, onRequestClosePane, onSetTitle, rightClickToPaste }) {
    const contextPaneIdRef = useRef(null);
    const menuOpenedAtRef = useRef(0);
    const [open, setOpen] = useState(false);
    const [point, setPoint] = useState({ x: 0, y: 0 });
    useEffect(() => {
        const closeMenu = () => {
            if (Date.now() - menuOpenedAtRef.current < 100) {
                return;
            }
            setOpen(false);
        };
        window.addEventListener(CLOSE_ALL_CONTEXT_MENUS_EVENT, closeMenu);
        return () => window.removeEventListener(CLOSE_ALL_CONTEXT_MENUS_EVENT, closeMenu);
    }, []);
    const resolveMenuPane = () => {
        const manager = managerRef.current;
        if (!manager) {
            return null;
        }
        const panes = manager.getPanes();
        if (contextPaneIdRef.current !== null) {
            const clickedPane = panes.find((pane) => pane.id === contextPaneIdRef.current) ?? null;
            if (clickedPane) {
                return clickedPane;
            }
        }
        return manager.getActivePane() ?? panes[0] ?? null;
    };
    const onCopy = async () => {
        const pane = resolveMenuPane();
        if (!pane) {
            return;
        }
        const selection = pane.terminal.getSelection();
        if (selection) {
            await window.api.ui.writeClipboardText(selection);
        }
    };
    const onPaste = async () => {
        const pane = resolveMenuPane();
        if (!pane) {
            return;
        }
        const text = await window.api.ui.readClipboardText();
        if (text) {
            pane.terminal.paste(text);
            return;
        }
        // Why: clipboard has no text — check for an image (e.g. screenshot).
        // Saves the image to a temp file and pastes the path so CLI tools like
        // Claude Code can access it, consistent with the keyboard paste path.
        const filePath = await window.api.ui.saveClipboardImageAsTempFile();
        if (filePath) {
            pane.terminal.paste(filePath);
        }
    };
    const onSplitRight = () => {
        const pane = resolveMenuPane();
        if (pane) {
            managerRef.current?.splitPane(pane.id, 'vertical');
        }
    };
    const onSplitDown = () => {
        const pane = resolveMenuPane();
        if (pane) {
            managerRef.current?.splitPane(pane.id, 'horizontal');
        }
    };
    const onClosePane = () => {
        const pane = resolveMenuPane();
        if (pane && (managerRef.current?.getPanes().length ?? 0) > 1) {
            onRequestClosePane(pane.id);
        }
    };
    const onClearScreen = () => {
        const pane = resolveMenuPane();
        if (pane) {
            pane.terminal.clear();
        }
    };
    const onToggleExpand = () => {
        const pane = resolveMenuPane();
        if (pane) {
            toggleExpandPane(pane.id);
        }
    };
    const handleSetTitle = () => {
        const pane = resolveMenuPane();
        if (pane) {
            onSetTitle(pane.id);
        }
    };
    const onContextMenuCapture = (event) => {
        event.preventDefault();
        window.dispatchEvent(new Event(CLOSE_ALL_CONTEXT_MENUS_EVENT));
        const manager = managerRef.current;
        if (!manager) {
            contextPaneIdRef.current = null;
            return;
        }
        const target = event.target;
        if (!(target instanceof Node)) {
            contextPaneIdRef.current = null;
            return;
        }
        const clickedPane = manager.getPanes().find((pane) => pane.container.contains(target)) ?? null;
        contextPaneIdRef.current = clickedPane?.id ?? null;
        // Why: Windows terminals treat right-click as copy-or-paste depending on
        // whether text is selected. With a selection, right-click copies it and
        // clears the selection; without one, it pastes. Ctrl+right-click still
        // reaches the app menu so the menu remains discoverable.
        if (rightClickToPaste && !event.ctrlKey) {
            event.stopPropagation();
            const selection = clickedPane?.terminal.getSelection();
            if (selection) {
                void window.api.ui.writeClipboardText(selection);
                clickedPane?.terminal.clearSelection();
            }
            else {
                void onPaste();
            }
            return;
        }
        menuOpenedAtRef.current = Date.now();
        const bounds = event.currentTarget.getBoundingClientRect();
        setPoint({ x: event.clientX - bounds.left, y: event.clientY - bounds.top });
        setOpen(true);
    };
    const paneCount = managerRef.current?.getPanes().length ?? 1;
    const menuPaneId = resolveMenuPane()?.id ?? null;
    return {
        open,
        setOpen,
        point,
        menuOpenedAtRef,
        paneCount,
        menuPaneId,
        onContextMenuCapture,
        onCopy,
        onPaste,
        onSplitRight,
        onSplitDown,
        onClosePane,
        onClearScreen,
        onToggleExpand,
        onSetTitle: handleSetTitle
    };
}
