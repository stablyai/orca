import { useCallback } from 'react';
import { detectLanguage } from '@/lib/language-detect';
export function useFileExplorerHandlers({ activeWorktreeId, openFile, pinFile, toggleDir, setSelectedPath, scrollRef }) {
    const handleClick = useCallback((node) => {
        if (!activeWorktreeId) {
            return;
        }
        setSelectedPath(node.path);
        if (node.isDirectory) {
            toggleDir(activeWorktreeId, node.path);
            return;
        }
        openFile({
            filePath: node.path,
            relativePath: node.relativePath,
            worktreeId: activeWorktreeId,
            language: detectLanguage(node.name),
            mode: 'edit'
        });
    }, [activeWorktreeId, openFile, toggleDir, setSelectedPath]);
    const handleDoubleClick = useCallback((node) => {
        if (!activeWorktreeId || node.isDirectory) {
            return;
        }
        pinFile(node.path);
    }, [activeWorktreeId, pinFile]);
    const handleWheelCapture = useCallback((e) => {
        const container = scrollRef.current;
        if (!container || Math.abs(e.deltaY) <= Math.abs(e.deltaX)) {
            return;
        }
        const target = e.target;
        if (!(target instanceof Element) || !target.closest('[data-explorer-draggable="true"]')) {
            return;
        }
        if (container.scrollHeight <= container.clientHeight) {
            return;
        }
        e.preventDefault();
        container.scrollTop += e.deltaY;
    }, [scrollRef]);
    return { handleClick, handleDoubleClick, handleWheelCapture };
}
