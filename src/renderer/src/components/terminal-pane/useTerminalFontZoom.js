import { useEffect } from 'react';
import { dispatchZoomLevelChanged } from '@/lib/zoom-events';
export function useTerminalFontZoom({ isActive, managerRef, paneFontSizesRef, settingsRef }) {
    useEffect(() => {
        if (!isActive) {
            return;
        }
        const MIN_FONT_SIZE = 8;
        const MAX_FONT_SIZE = 32;
        const FONT_SIZE_STEP = 1;
        return window.api.ui.onTerminalZoom((direction) => {
            const manager = managerRef.current;
            if (!manager) {
                return;
            }
            const pane = manager.getActivePane();
            if (!pane) {
                return;
            }
            const globalSize = settingsRef.current?.terminalFontSize ?? 14;
            const currentSize = paneFontSizesRef.current.get(pane.id) ?? globalSize;
            let nextSize;
            if (direction === 'reset') {
                nextSize = globalSize;
                paneFontSizesRef.current.delete(pane.id);
            }
            else if (direction === 'in') {
                nextSize = Math.min(MAX_FONT_SIZE, currentSize + FONT_SIZE_STEP);
                paneFontSizesRef.current.set(pane.id, nextSize);
            }
            else {
                nextSize = Math.max(MIN_FONT_SIZE, currentSize - FONT_SIZE_STEP);
                paneFontSizesRef.current.set(pane.id, nextSize);
            }
            pane.terminal.options.fontSize = nextSize;
            try {
                const buf = pane.terminal.buffer.active;
                const wasAtBottom = buf.viewportY >= buf.baseY;
                pane.fitAddon.fit();
                if (wasAtBottom) {
                    pane.terminal.scrollToBottom();
                }
            }
            catch {
                /* ignore */
            }
            const percent = Math.round((nextSize / globalSize) * 100);
            dispatchZoomLevelChanged('terminal', percent);
        });
    }, [isActive, managerRef, paneFontSizesRef, settingsRef]);
}
