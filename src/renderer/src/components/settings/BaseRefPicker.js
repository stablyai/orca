import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useEffect, useState } from 'react';
import { ScrollArea } from '../ui/scroll-area';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
export function BaseRefPicker({ repoId, currentBaseRef, onSelect, onUsePrimary }) {
    const [defaultBaseRef, setDefaultBaseRef] = useState('origin/main');
    const [baseRefQuery, setBaseRefQuery] = useState('');
    const [baseRefResults, setBaseRefResults] = useState([]);
    const [isSearchingBaseRefs, setIsSearchingBaseRefs] = useState(false);
    useEffect(() => {
        let stale = false;
        const loadDefaultBaseRef = async () => {
            try {
                const result = await window.api.repos.getBaseRefDefault({ repoId });
                if (!stale) {
                    setDefaultBaseRef(result);
                }
            }
            catch {
                if (!stale) {
                    setDefaultBaseRef('origin/main');
                }
            }
        };
        setBaseRefQuery('');
        setBaseRefResults([]);
        void loadDefaultBaseRef();
        return () => {
            stale = true;
        };
    }, [repoId]);
    useEffect(() => {
        const trimmedQuery = baseRefQuery.trim();
        if (trimmedQuery.length < 2) {
            setBaseRefResults([]);
            setIsSearchingBaseRefs(false);
            return;
        }
        let stale = false;
        setIsSearchingBaseRefs(true);
        const timer = window.setTimeout(() => {
            void window.api.repos
                .searchBaseRefs({
                repoId,
                query: trimmedQuery,
                limit: 20
            })
                .then((results) => {
                if (!stale) {
                    setBaseRefResults(results);
                }
            })
                .catch(() => {
                if (!stale) {
                    setBaseRefResults([]);
                }
            })
                .finally(() => {
                if (!stale) {
                    setIsSearchingBaseRefs(false);
                }
            });
        }, 200);
        return () => {
            stale = true;
            window.clearTimeout(timer);
        };
    }, [baseRefQuery, repoId]);
    const effectiveBaseRef = currentBaseRef ?? defaultBaseRef;
    return (_jsxs("div", { className: "space-y-2.5", children: [_jsxs("div", { className: "flex flex-wrap items-center justify-between gap-2", children: [_jsxs("div", { children: [_jsx("div", { className: "text-sm font-medium text-foreground", children: effectiveBaseRef }), _jsx("p", { className: "text-xs text-muted-foreground", children: currentBaseRef
                                    ? 'Pinned for this repo'
                                    : `Following primary branch (${defaultBaseRef})` })] }), onUsePrimary && (_jsx(Button, { variant: "outline", size: "sm", onClick: onUsePrimary, disabled: !currentBaseRef, children: "Use Primary" }))] }), _jsxs("div", { className: "space-y-2", children: [_jsx(Input, { value: baseRefQuery, onChange: (e) => setBaseRefQuery(e.target.value), placeholder: "Search branches by name...", className: "max-w-md" }), _jsx("p", { className: "text-xs text-muted-foreground", children: "Type at least 2 characters." })] }), isSearchingBaseRefs ? (_jsx("p", { className: "text-xs text-muted-foreground", children: "Searching branches..." })) : null, !isSearchingBaseRefs && baseRefQuery.trim().length >= 2 ? (baseRefResults.length > 0 ? (_jsx(ScrollArea, { className: "h-48 rounded-md border border-border/50", children: _jsx("div", { className: "p-1", children: baseRefResults.map((ref) => (_jsxs("button", { onClick: () => {
                            setBaseRefQuery(ref);
                            setBaseRefResults([]);
                            onSelect(ref);
                        }, className: `flex w-full items-center justify-between rounded-sm px-3 py-2 text-left text-sm transition-colors hover:bg-muted/60 ${effectiveBaseRef === ref
                            ? 'bg-accent text-accent-foreground'
                            : 'text-foreground'}`, children: [_jsx("span", { className: "truncate", children: ref }), effectiveBaseRef === ref ? (_jsx("span", { className: "text-[10px] uppercase tracking-[0.18em]", children: "Current" })) : null] }, ref))) }) })) : (_jsx("p", { className: "text-xs text-muted-foreground", children: "No matching branches found." }))) : null] }));
}
