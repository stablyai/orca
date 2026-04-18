import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ChevronRight, Folder, File, ArrowUp, LoaderCircle, Home } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
export function RemoteFileBrowser({ targetId, initialPath = '~', onSelect, onCancel }) {
    const [resolvedPath, setResolvedPath] = useState('');
    const [entries, setEntries] = useState([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(null);
    const [selectedName, setSelectedName] = useState(null);
    const genRef = useRef(0);
    const loadDir = useCallback(async (dirPath) => {
        const gen = ++genRef.current;
        setLoading(true);
        setError(null);
        setSelectedName(null);
        try {
            const result = await window.api.ssh.browseDir({ targetId, dirPath });
            if (gen !== genRef.current) {
                return;
            }
            setResolvedPath(result.resolvedPath);
            setEntries(result.entries);
        }
        catch (err) {
            if (gen !== genRef.current) {
                return;
            }
            setError(err instanceof Error ? err.message : String(err));
            setEntries([]);
        }
        finally {
            if (gen === genRef.current) {
                setLoading(false);
            }
        }
    }, [targetId]);
    useEffect(() => {
        loadDir(initialPath);
    }, [loadDir, initialPath]);
    const navigateTo = useCallback((name) => {
        const next = resolvedPath === '/' ? `/${name}` : `${resolvedPath}/${name}`;
        loadDir(next);
    }, [resolvedPath, loadDir]);
    const navigateUp = useCallback(() => {
        if (resolvedPath === '/') {
            return;
        }
        const parent = resolvedPath.replace(/\/[^/]+\/?$/, '') || '/';
        loadDir(parent);
    }, [resolvedPath, loadDir]);
    const handleDoubleClick = useCallback((entry) => {
        if (entry.isDirectory) {
            navigateTo(entry.name);
        }
    }, [navigateTo]);
    const handleSelect = useCallback(() => {
        if (selectedName) {
            const full = resolvedPath === '/' ? `/${selectedName}` : `${resolvedPath}/${selectedName}`;
            onSelect(full);
        }
        else {
            onSelect(resolvedPath);
        }
    }, [resolvedPath, selectedName, onSelect]);
    const pathSegments = resolvedPath.split('/').filter(Boolean);
    return (_jsxs("div", { className: "flex flex-col gap-2", children: [_jsxs("div", { className: "flex items-center gap-0.5 min-h-[28px] overflow-x-auto scrollbar-none", children: [_jsx("button", { type: "button", onClick: navigateUp, disabled: resolvedPath === '/' || loading, className: "shrink-0 p-1 rounded hover:bg-accent disabled:opacity-30 transition-colors cursor-pointer disabled:cursor-default", children: _jsx(ArrowUp, { className: "size-3.5" }) }), _jsx("button", { type: "button", onClick: () => loadDir('~'), disabled: loading, className: "shrink-0 p-1 rounded hover:bg-accent transition-colors cursor-pointer", children: _jsx(Home, { className: "size-3.5" }) }), _jsxs("div", { className: "flex items-center gap-0 text-[11px] text-muted-foreground ml-1 min-w-0", children: [_jsx("button", { type: "button", onClick: () => loadDir('/'), className: "shrink-0 hover:text-foreground transition-colors cursor-pointer px-0.5", children: "/" }), pathSegments.map((segment, i) => (_jsxs(React.Fragment, { children: [_jsx(ChevronRight, { className: "size-2.5 shrink-0 text-muted-foreground/50" }), _jsx("button", { type: "button", onClick: () => loadDir(`/${pathSegments.slice(0, i + 1).join('/')}`), className: cn('truncate max-w-[120px] hover:text-foreground transition-colors cursor-pointer px-0.5', i === pathSegments.length - 1 && 'text-foreground font-medium'), children: segment })] }, i)))] })] }), _jsx("div", { className: "border border-border rounded-md overflow-hidden bg-background", children: _jsx("div", { className: "h-[240px] overflow-y-auto scrollbar-sleek", children: loading ? (_jsx("div", { className: "flex items-center justify-center h-full", children: _jsx(LoaderCircle, { className: "size-5 animate-spin text-muted-foreground" }) })) : error ? (_jsx("div", { className: "flex items-center justify-center h-full px-4", children: _jsx("p", { className: "text-xs text-destructive text-center", children: error }) })) : entries.length === 0 ? (_jsx("div", { className: "flex items-center justify-center h-full", children: _jsx("p", { className: "text-xs text-muted-foreground", children: "Empty directory" }) })) : (entries.map((entry) => (_jsxs("button", { type: "button", className: cn('w-full flex items-center gap-2 px-3 py-1.5 text-xs text-left transition-colors cursor-pointer', 'hover:bg-accent/60', selectedName === entry.name && 'bg-accent'), onClick: () => setSelectedName(entry.name), onDoubleClick: () => handleDoubleClick(entry), children: [entry.isDirectory ? (_jsx(Folder, { className: "size-3.5 text-blue-400 shrink-0" })) : (_jsx(File, { className: "size-3.5 text-muted-foreground/60 shrink-0" })), _jsx("span", { className: "truncate", children: entry.name })] }, entry.name)))) }) }), _jsxs("div", { className: "flex items-center justify-between gap-2", children: [_jsx("p", { className: "text-[10px] text-muted-foreground truncate", children: selectedName ? `${resolvedPath}/${selectedName}` : resolvedPath }), _jsxs("div", { className: "flex items-center gap-2 shrink-0", children: [_jsx(Button, { variant: "outline", size: "sm", className: "h-7 text-xs", onClick: onCancel, children: "Cancel" }), _jsx(Button, { size: "sm", className: "h-7 text-xs", onClick: handleSelect, disabled: loading, children: "Select" })] })] })] }));
}
