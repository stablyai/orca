import { useState, useCallback, useEffect, useRef } from 'react';
export function reconcileSelectionKeys(selectedKeys, flatEntries) {
    const validKeys = new Set(flatEntries.map((e) => e.key));
    const nextSelected = new Set();
    for (const key of selectedKeys) {
        if (validKeys.has(key)) {
            nextSelected.add(key);
        }
    }
    return nextSelected;
}
export function getSelectionRangeKeys(flatEntries, anchorKey, currentKey) {
    const anchorIndex = flatEntries.findIndex((e) => e.key === anchorKey);
    const currentIndex = flatEntries.findIndex((e) => e.key === currentKey);
    if (anchorIndex === -1 || currentIndex === -1) {
        return null;
    }
    const start = Math.min(anchorIndex, currentIndex);
    const end = Math.max(anchorIndex, currentIndex);
    const nextSelected = new Set();
    for (let i = start; i <= end; i++) {
        nextSelected.add(flatEntries[i].key);
    }
    return nextSelected;
}
export function useSourceControlSelection({ flatEntries, onOpenDiff, containerRef }) {
    const [selectedKeys, setSelectedKeys] = useState(new Set());
    const [anchorKey, setAnchorKey] = useState(null);
    const flatEntriesRef = useRef(flatEntries);
    const anchorKeyRef = useRef(anchorKey);
    const selectedKeysRef = useRef(selectedKeys);
    const onOpenDiffRef = useRef(onOpenDiff);
    useEffect(() => {
        flatEntriesRef.current = flatEntries;
    }, [flatEntries]);
    useEffect(() => {
        anchorKeyRef.current = anchorKey;
    }, [anchorKey]);
    useEffect(() => {
        selectedKeysRef.current = selectedKeys;
    }, [selectedKeys]);
    useEffect(() => {
        onOpenDiffRef.current = onOpenDiff;
    }, [onOpenDiff]);
    // Clear stale selections if entries disappear
    useEffect(() => {
        const validKeys = new Set(flatEntries.map((e) => e.key));
        const nextSelected = reconcileSelectionKeys(selectedKeys, flatEntries);
        const changed = nextSelected.size !== selectedKeys.size;
        if (changed) {
            setSelectedKeys(nextSelected);
        }
        if (anchorKey && !validKeys.has(anchorKey)) {
            setAnchorKey(null);
        }
    }, [flatEntries, selectedKeys, anchorKey]);
    const handleSelect = useCallback((e, key, entry) => {
        const isShift = e.shiftKey;
        const isCmdOrCtrl = e.metaKey || e.ctrlKey;
        if (isShift) {
            const nextSelected = getSelectionRangeKeys(flatEntriesRef.current, anchorKeyRef.current, key);
            if (nextSelected) {
                setSelectedKeys(nextSelected);
                return;
            }
            // Why: when the anchor row disappears from the visible list because a
            // section collapsed or status changed, the next Shift-click should
            // fall back to the single-click behavior instead of selecting from a
            // stale invisible anchor.
            setSelectedKeys(new Set());
            setAnchorKey(key);
            onOpenDiffRef.current(entry);
        }
        else if (isCmdOrCtrl) {
            // Toggle individual
            setSelectedKeys((prev) => {
                const next = new Set(prev);
                if (next.has(key)) {
                    next.delete(key);
                    // Keep anchorKey as is
                }
                else {
                    next.add(key);
                    setAnchorKey(key);
                }
                return next;
            });
        }
        else {
            // Plain click
            setSelectedKeys((prev) => {
                if (prev.size > 0) {
                    return new Set();
                }
                return prev;
            });
            setAnchorKey(key);
            onOpenDiffRef.current(entry);
        }
    }, []);
    const handleContextMenu = useCallback((key) => {
        if (!selectedKeysRef.current.has(key)) {
            setSelectedKeys(new Set([key]));
            setAnchorKey(key);
        }
    }, []);
    const clearSelection = useCallback(() => {
        setSelectedKeys(new Set());
        setAnchorKey(null);
    }, []);
    useEffect(() => {
        const handleKeyDown = (e) => {
            if (e.key === 'Escape' && selectedKeys.size > 0) {
                e.preventDefault();
                clearSelection();
            }
        };
        document.addEventListener('keydown', handleKeyDown);
        return () => document.removeEventListener('keydown', handleKeyDown);
    }, [selectedKeys.size, clearSelection]);
    useEffect(() => {
        const handlePointerDown = (e) => {
            if (selectedKeys.size === 0) {
                return;
            }
            const container = containerRef.current;
            const target = e.target;
            if (!container || !(target instanceof Node) || container.contains(target)) {
                return;
            }
            clearSelection();
        };
        // Why: use capture so outside clicks clear the selection before the next
        // UI surface handles the pointer event, matching standard desktop list UX.
        document.addEventListener('pointerdown', handlePointerDown, true);
        return () => document.removeEventListener('pointerdown', handlePointerDown, true);
    }, [selectedKeys.size, containerRef, clearSelection]);
    return {
        selectedKeys,
        handleSelect,
        handleContextMenu,
        clearSelection
    };
}
