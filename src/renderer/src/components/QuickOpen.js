import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
/* oxlint-disable max-lines */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { File } from 'lucide-react';
import { useAppStore } from '@/store';
import { detectLanguage } from '@/lib/language-detect';
import { joinPath } from '@/lib/path';
import { CommandDialog, CommandInput, CommandList, CommandEmpty, CommandItem } from '@/components/ui/command';
/**
 * Simple fuzzy match: checks if all characters in the query appear in order
 * within the target string (case-insensitive). Returns a score (lower = better)
 * or -1 if no match.
 */
function fuzzyMatch(query, target) {
    const q = query.toLowerCase();
    const t = target.toLowerCase();
    let qi = 0;
    let score = 0;
    let lastMatchIdx = -1;
    for (let ti = 0; ti < t.length && qi < q.length; ti++) {
        if (t[ti] === q[qi]) {
            // Bonus for consecutive matches
            const gap = lastMatchIdx === -1 ? 0 : ti - lastMatchIdx - 1;
            score += gap;
            // Bonus for matching after separator (/ or .)
            if (ti > 0 && (t[ti - 1] === '/' || t[ti - 1] === '.' || t[ti - 1] === '-')) {
                score -= 5; // reward
            }
            lastMatchIdx = ti;
            qi++;
        }
    }
    if (qi < q.length) {
        return -1; // not all chars matched
    }
    // Prefer matches where query appears in the filename (last segment)
    const lastSlash = target.lastIndexOf('/');
    const filename = target.slice(lastSlash + 1).toLowerCase();
    if (filename.includes(q)) {
        score -= 100; // strong reward for filename match
    }
    return score;
}
export default function QuickOpen() {
    const visible = useAppStore((s) => s.activeModal === 'quick-open');
    const closeModal = useAppStore((s) => s.closeModal);
    const activeWorktreeId = useAppStore((s) => s.activeWorktreeId);
    const worktreesByRepo = useAppStore((s) => s.worktreesByRepo);
    const openFile = useAppStore((s) => s.openFile);
    const [query, setQuery] = useState('');
    const [files, setFiles] = useState([]);
    const [loading, setLoading] = useState(false);
    const [loadError, setLoadError] = useState(null);
    // Find active worktree path
    const worktreePath = useMemo(() => {
        if (!activeWorktreeId) {
            return null;
        }
        for (const worktrees of Object.values(worktreesByRepo)) {
            const wt = worktrees.find((w) => w.id === activeWorktreeId);
            if (wt) {
                return wt.path;
            }
        }
        return null;
    }, [activeWorktreeId, worktreesByRepo]);
    // Load file list when opened
    useEffect(() => {
        if (!visible) {
            return;
        }
        if (!worktreePath) {
            setFiles([]);
            return;
        }
        let cancelled = false;
        setQuery('');
        setFiles([]);
        setLoadError(null);
        setLoading(true);
        void window.api.fs
            .listFiles({ rootPath: worktreePath })
            .then((result) => {
            if (!cancelled) {
                setFiles(result);
            }
        })
            .catch((error) => {
            if (!cancelled) {
                setFiles([]);
                // Why: treating list-files failures as "no matches" hides the real
                // cause when the active worktree path is unauthorized or stale.
                setLoadError(error instanceof Error ? error.message : String(error));
            }
        })
            .finally(() => {
            if (!cancelled) {
                setLoading(false);
            }
        });
        return () => {
            cancelled = true;
        };
    }, [visible, worktreePath]);
    // Filter files by fuzzy match
    const filtered = useMemo(() => {
        if (!query.trim()) {
            // Show first 50 files when no query
            return files.slice(0, 50).map((f) => ({ path: f, score: 0 }));
        }
        const results = [];
        for (const f of files) {
            const score = fuzzyMatch(query.trim(), f);
            if (score !== -1) {
                results.push({ path: f, score });
            }
        }
        results.sort((a, b) => a.score - b.score);
        return results.slice(0, 50);
    }, [files, query]);
    const handleSelect = useCallback((relativePath) => {
        if (!activeWorktreeId || !worktreePath) {
            return;
        }
        closeModal();
        openFile({
            filePath: joinPath(worktreePath, relativePath),
            relativePath,
            worktreeId: activeWorktreeId,
            language: detectLanguage(relativePath),
            mode: 'edit'
        });
    }, [activeWorktreeId, worktreePath, openFile, closeModal]);
    const handleOpenChange = useCallback((open) => {
        if (!open) {
            closeModal();
        }
    }, [closeModal]);
    const handleCloseAutoFocus = useCallback((e) => {
        // Why: prevent Radix from stealing focus to the trigger element.
        e.preventDefault();
    }, []);
    return (_jsxs(CommandDialog, { open: visible, onOpenChange: handleOpenChange, shouldFilter: false, onCloseAutoFocus: handleCloseAutoFocus, title: "Go to file", description: "Search for a file to open", children: [_jsx(CommandInput, { placeholder: "Go to file...", value: query, onValueChange: setQuery }), _jsx(CommandList, { children: loading ? (_jsx("div", { className: "py-6 text-center text-sm text-muted-foreground", children: "Loading files..." })) : loadError ? (_jsx("div", { className: "py-6 text-center text-sm text-red-500", children: loadError })) : filtered.length === 0 ? (_jsx(CommandEmpty, { children: "No matching files." })) : (filtered.map((item) => {
                    const lastSlash = item.path.lastIndexOf('/');
                    const dir = lastSlash >= 0 ? item.path.slice(0, lastSlash) : '';
                    const filename = item.path.slice(lastSlash + 1);
                    return (_jsxs(CommandItem, { value: item.path, onSelect: () => handleSelect(item.path), className: "flex items-center gap-2 px-3 py-1.5", children: [_jsx(File, { size: 14, className: "text-muted-foreground flex-shrink-0" }), _jsx("span", { className: "truncate text-foreground", children: filename }), dir && _jsx("span", { className: "truncate text-muted-foreground ml-1", children: dir })] }, item.path));
                })) }), _jsx("div", { "aria-live": "polite", className: "sr-only", children: query.trim() ? `${filtered.length} files found` : '' })] }));
}
