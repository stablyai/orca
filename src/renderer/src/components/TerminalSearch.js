import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useEffect, useRef, useState, useCallback } from 'react';
import { ChevronUp, ChevronDown, X, CaseSensitive, Regex } from 'lucide-react';
import { Button } from '@/components/ui/button';
export default function TerminalSearch({ isOpen, onClose, searchAddon, searchStateRef }) {
    const inputRef = useRef(null);
    const [query, setQuery] = useState('');
    const [caseSensitive, setCaseSensitive] = useState(false);
    const [regex, setRegex] = useState(false);
    const searchOptions = useCallback((incremental = false) => ({ caseSensitive, regex, incremental }), [caseSensitive, regex]);
    const findNext = useCallback(() => {
        if (searchAddon && query) {
            searchAddon.findNext(query, searchOptions());
        }
    }, [searchAddon, query, searchOptions]);
    const findPrevious = useCallback(() => {
        if (searchAddon && query) {
            searchAddon.findPrevious(query, searchOptions());
        }
    }, [searchAddon, query, searchOptions]);
    useEffect(() => {
        if (isOpen) {
            inputRef.current?.focus();
        }
        else {
            searchAddon?.clearDecorations();
        }
    }, [isOpen, searchAddon]);
    useEffect(() => {
        // Keep the ref in sync so the keyboard handler (Cmd+G / Cmd+Shift+G)
        // can read the current search state without lifting it to parent state.
        searchStateRef.current = { query, caseSensitive, regex };
        if (!query) {
            searchAddon?.clearDecorations();
            return;
        }
        if (searchAddon && isOpen) {
            searchAddon.findNext(query, { caseSensitive, regex, incremental: true });
        }
    }, [query, searchAddon, isOpen, caseSensitive, regex, searchStateRef]);
    const handleKeyDown = useCallback((e) => {
        e.stopPropagation();
        if (e.key === 'Escape') {
            onClose();
        }
        else if (e.key === 'Enter' && e.shiftKey) {
            findPrevious();
        }
        else if (e.key === 'Enter') {
            findNext();
        }
    }, [onClose, findNext, findPrevious]);
    if (!isOpen) {
        return null;
    }
    return (_jsxs("div", { "data-terminal-search-root": true, className: "absolute top-2 right-2 z-50 flex items-center gap-1 rounded-lg border border-zinc-700 bg-zinc-800/95 px-2 py-1 shadow-lg backdrop-blur-sm", style: { width: 300 }, onKeyDown: handleKeyDown, children: [_jsx("input", { ref: inputRef, type: "text", value: query, onChange: (e) => setQuery(e.target.value), placeholder: "Search...", className: "min-w-0 flex-1 border-none bg-transparent text-sm text-white outline-none placeholder:text-zinc-500" }), _jsx(Button, { type: "button", variant: "ghost", size: "icon-xs", onClick: () => setCaseSensitive((v) => !v), className: `flex size-6 shrink-0 items-center justify-center rounded ${caseSensitive ? 'bg-zinc-700/50 text-blue-400' : 'text-zinc-400 hover:text-zinc-200'}`, title: "Case sensitive", children: _jsx(CaseSensitive, { size: 14 }) }), _jsx(Button, { type: "button", variant: "ghost", size: "icon-xs", onClick: () => setRegex((v) => !v), className: `flex size-6 shrink-0 items-center justify-center rounded ${regex ? 'bg-zinc-700/50 text-blue-400' : 'text-zinc-400 hover:text-zinc-200'}`, title: "Regex", children: _jsx(Regex, { size: 14 }) }), _jsx("div", { className: "mx-0.5 h-4 w-px bg-zinc-700" }), _jsx(Button, { type: "button", variant: "ghost", size: "icon-xs", onClick: findPrevious, className: "flex size-6 shrink-0 items-center justify-center rounded text-zinc-400 hover:text-zinc-200", title: "Previous match", children: _jsx(ChevronUp, { size: 14 }) }), _jsx(Button, { type: "button", variant: "ghost", size: "icon-xs", onClick: findNext, className: "flex size-6 shrink-0 items-center justify-center rounded text-zinc-400 hover:text-zinc-200", title: "Next match", children: _jsx(ChevronDown, { size: 14 }) }), _jsx("div", { className: "mx-0.5 h-4 w-px bg-zinc-700" }), _jsx(Button, { type: "button", variant: "ghost", size: "icon-xs", onClick: onClose, className: "flex size-6 shrink-0 items-center justify-center rounded text-zinc-400 hover:text-zinc-200", title: "Close", children: _jsx(X, { size: 14 }) })] }));
}
