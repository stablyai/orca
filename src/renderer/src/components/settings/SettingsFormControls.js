import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
/* eslint-disable max-lines -- Why: these small settings form primitives and controls
co-locate shared layout and keyboard interaction logic, which keeps the settings
panel wiring simple even though the file exceeds the default line limit. */
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { ScrollArea } from '../ui/scroll-area';
import { Input } from '../ui/input';
import { Label } from '../ui/label';
import { Check, ChevronsUpDown, CircleX } from 'lucide-react';
import { BUILTIN_TERMINAL_THEME_NAMES, normalizeColor } from '@/lib/terminal-theme';
import { MAX_THEME_RESULTS } from './SettingsConstants';
export function ThemePicker({ label, description, selectedTheme, query, onQueryChange, onSelectTheme }) {
    const normalizedQuery = query.trim().toLowerCase();
    const filteredThemes = BUILTIN_TERMINAL_THEME_NAMES.filter((theme) => theme.toLowerCase().includes(normalizedQuery)).slice(0, MAX_THEME_RESULTS);
    return (_jsxs("div", { className: "space-y-3", children: [_jsxs("div", { className: "space-y-1", children: [_jsx(Label, { children: label }), _jsx("p", { className: "text-xs text-muted-foreground", children: description })] }), _jsx(Input, { value: query, onChange: (e) => onQueryChange(e.target.value), placeholder: "Search builtin themes" }), _jsxs("div", { className: "rounded-lg border border-border/50", children: [_jsxs("div", { className: "flex items-center justify-between border-b border-border/50 px-3 py-2 text-xs text-muted-foreground", children: [_jsxs("span", { children: ["Selected: ", selectedTheme] }), _jsxs("span", { children: ["Showing ", filteredThemes.length, normalizedQuery
                                        ? ` matching "${query.trim()}"`
                                        : ` of ${BUILTIN_TERMINAL_THEME_NAMES.length}`] })] }), _jsx(ScrollArea, { className: "h-64", children: _jsxs("div", { className: "space-y-1 p-2", children: [filteredThemes.map((theme) => (_jsxs("button", { onClick: () => onSelectTheme(theme), className: `flex w-full items-center justify-between rounded-md px-3 py-2 text-left text-sm transition-colors ${selectedTheme === theme
                                        ? 'bg-accent font-medium text-accent-foreground'
                                        : 'hover:bg-muted/60'}`, children: [_jsx("span", { className: "truncate", children: theme }), selectedTheme === theme ? (_jsx("span", { className: "ml-3 shrink-0 text-[11px] uppercase tracking-[0.16em]", children: "Current" })) : null] }, theme))), filteredThemes.length === 0 ? (_jsx("div", { className: "px-3 py-6 text-sm text-muted-foreground", children: "No themes found." })) : null] }) })] })] }));
}
export function ColorField({ label, description, value, fallback, onChange }) {
    const normalized = normalizeColor(value, fallback);
    return (_jsxs("div", { className: "space-y-2", children: [_jsxs("div", { className: "space-y-1", children: [_jsx(Label, { children: label }), _jsx("p", { className: "text-xs text-muted-foreground", children: description })] }), _jsxs("div", { className: "flex items-center gap-3", children: [_jsx("input", { type: "color", value: normalized, onChange: (e) => onChange(e.target.value), className: "h-9 w-12 rounded-md border border-input bg-transparent p-1" }), _jsx(Input, { value: value, onChange: (e) => onChange(e.target.value), placeholder: fallback, className: "max-w-xs text-xs" })] })] }));
}
export function NumberField({ label, description, value, defaultValue, min, max, step = 1, onChange, suffix }) {
    const [draft, setDraft] = useState(Number.isFinite(value) ? String(value) : '');
    const [prevValue, setPrevValue] = useState(value);
    // Sync draft when the external value changes (e.g. from another source)
    if (value !== prevValue) {
        setPrevValue(value);
        setDraft(Number.isFinite(value) ? String(value) : '');
    }
    const commit = () => {
        const trimmed = draft.trim();
        if (trimmed === '') {
            // Empty input — reset to current value rather than committing 0
            setDraft(Number.isFinite(value) ? String(value) : '');
            return;
        }
        const next = Number(trimmed);
        if (Number.isFinite(next)) {
            const clamped = Math.min(max, Math.max(min, next));
            onChange(clamped);
            setDraft(String(clamped));
        }
        else {
            // Reset to current value if input is invalid
            setDraft(Number.isFinite(value) ? String(value) : '');
        }
    };
    return (_jsxs("div", { className: "space-y-2", children: [_jsxs("div", { className: "space-y-1", children: [_jsx(Label, { children: label }), _jsx("p", { className: "text-xs text-muted-foreground", children: description })] }), _jsxs("div", { className: "flex items-center gap-3", children: [_jsx(Input, { type: "number", min: min, max: max, step: step, value: draft, onChange: (e) => setDraft(e.target.value), onBlur: commit, onKeyDown: (e) => {
                            if (e.key === 'Enter') {
                                commit();
                            }
                        }, className: "number-input-clean w-28 tabular-nums" }), suffix ? _jsx("span", { className: "text-xs text-muted-foreground", children: suffix }) : null] }), _jsxs("p", { className: "text-[11px] text-muted-foreground", children: ["Current: ", value, defaultValue !== undefined ? ` · Default: ${defaultValue}` : ''] })] }));
}
export function FontAutocomplete({ value, suggestions, onChange }) {
    const [query, setQuery] = useState(value);
    const [prevValue, setPrevValue] = useState(value);
    const [open, setOpen] = useState(false);
    const [highlightedIndex, setHighlightedIndex] = useState(-1);
    const inputRef = useRef(null);
    const rootRef = useRef(null);
    const optionRefs = useRef(new Map());
    const listboxId = useId();
    if (value !== prevValue) {
        setPrevValue(value);
        setQuery(value);
    }
    useEffect(() => {
        if (!open) {
            return;
        }
        const handlePointerDown = (event) => {
            if (!rootRef.current?.contains(event.target)) {
                setOpen(false);
            }
        };
        document.addEventListener('mousedown', handlePointerDown);
        return () => document.removeEventListener('mousedown', handlePointerDown);
    }, [open]);
    const normalizedQuery = query.trim().toLowerCase();
    const filteredSuggestions = useMemo(() => {
        const startsWith = suggestions.filter((font) => font.toLowerCase().startsWith(normalizedQuery));
        const includes = suggestions.filter((font) => !font.toLowerCase().startsWith(normalizedQuery) &&
            font.toLowerCase().includes(normalizedQuery));
        return normalizedQuery ? [...startsWith, ...includes] : suggestions;
    }, [suggestions, normalizedQuery]);
    // Why: sync the highlighted index during render rather than via useEffect so
    // the correct item is highlighted on the very first paint after open/filter
    // changes — useEffect would leave one render with the stale index visible.
    const [prevFilteredSuggestions, setPrevFilteredSuggestions] = useState(filteredSuggestions);
    const [prevOpen, setPrevOpen] = useState(open);
    const [prevHighlightedValue, setPrevHighlightedValue] = useState(value);
    if (filteredSuggestions !== prevFilteredSuggestions ||
        open !== prevOpen ||
        value !== prevHighlightedValue) {
        setPrevFilteredSuggestions(filteredSuggestions);
        setPrevOpen(open);
        setPrevHighlightedValue(value);
        if (!open || filteredSuggestions.length === 0) {
            setHighlightedIndex(-1);
        }
        else {
            const selectedIndex = filteredSuggestions.findIndex((font) => font === value);
            setHighlightedIndex(Math.max(selectedIndex, 0));
        }
    }
    useEffect(() => {
        if (!open || highlightedIndex < 0) {
            return;
        }
        const highlightedFont = filteredSuggestions[highlightedIndex];
        if (!highlightedFont) {
            return;
        }
        optionRefs.current.get(highlightedFont)?.scrollIntoView({ block: 'nearest' });
    }, [filteredSuggestions, highlightedIndex, open]);
    const commitValue = (nextValue) => {
        setQuery(nextValue);
        onChange(nextValue);
        setOpen(false);
    };
    const focusInput = () => {
        inputRef.current?.focus();
    };
    return (_jsxs("div", { ref: rootRef, className: "relative max-w-sm", children: [_jsxs("div", { className: "relative", children: [_jsx(Input, { ref: inputRef, value: query, onChange: (e) => {
                            const next = e.target.value;
                            setQuery(next);
                            onChange(next);
                            setOpen(true);
                        }, onFocus: () => setOpen(true), onKeyDown: (e) => {
                            if (e.key === 'Escape') {
                                if (open) {
                                    e.preventDefault();
                                    setOpen(false);
                                }
                                return;
                            }
                            if (e.key === 'ArrowDown') {
                                e.preventDefault();
                                setOpen(true);
                                if (filteredSuggestions.length > 0) {
                                    setHighlightedIndex((current) => current < 0 ? 0 : Math.min(current + 1, filteredSuggestions.length - 1));
                                }
                                return;
                            }
                            if (e.key === 'ArrowUp') {
                                e.preventDefault();
                                setOpen(true);
                                if (filteredSuggestions.length > 0) {
                                    setHighlightedIndex((current) => current < 0 ? filteredSuggestions.length - 1 : Math.max(current - 1, 0));
                                }
                                return;
                            }
                            if (e.key === 'Enter' && open && highlightedIndex >= 0) {
                                const highlightedFont = filteredSuggestions[highlightedIndex];
                                if (highlightedFont) {
                                    e.preventDefault();
                                    commitValue(highlightedFont);
                                }
                            }
                        }, placeholder: "SF Mono", className: "pr-18", role: "combobox", "aria-autocomplete": "list", "aria-expanded": open, "aria-controls": listboxId, "aria-activedescendant": open && highlightedIndex >= 0 ? `${listboxId}-option-${highlightedIndex}` : undefined }), _jsxs("div", { className: "absolute inset-y-0 right-2 flex items-center gap-1", children: [query ? (_jsx("button", { type: "button", onMouseDown: (e) => e.preventDefault(), onClick: () => {
                                    setQuery('');
                                    onChange('');
                                    setOpen(true);
                                    focusInput();
                                }, className: "rounded-sm p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground", "aria-label": "Clear font selection", title: "Clear", children: _jsx(CircleX, { className: "size-3.5" }) })) : null, _jsx("button", { type: "button", onMouseDown: (e) => e.preventDefault(), onClick: () => {
                                    const nextOpen = !open;
                                    setOpen(nextOpen);
                                    if (nextOpen) {
                                        focusInput();
                                    }
                                }, className: "rounded-sm p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground", "aria-label": "Toggle font suggestions", title: "Fonts", children: _jsx(ChevronsUpDown, { className: "size-3.5" }) })] })] }), open ? (_jsx("div", { className: "absolute top-full z-20 mt-2 w-full overflow-hidden rounded-md border border-border/50 bg-popover shadow-md", children: _jsx(ScrollArea, { className: filteredSuggestions.length > 8 ? 'h-64' : undefined, children: _jsx("div", { id: listboxId, role: "listbox", className: "p-1", children: filteredSuggestions.length > 0 ? (filteredSuggestions.map((font, index) => (_jsxs("button", { type: "button", id: `${listboxId}-option-${index}`, role: "option", "aria-selected": index === highlightedIndex, ref: (element) => {
                                if (element) {
                                    optionRefs.current.set(font, element);
                                    return;
                                }
                                optionRefs.current.delete(font);
                            }, onMouseDown: (e) => e.preventDefault(), onMouseEnter: () => setHighlightedIndex(index), onClick: () => commitValue(font), className: `flex w-full items-center justify-between rounded-sm px-3 py-2 text-left text-sm transition-colors ${index === highlightedIndex
                                ? 'bg-accent text-accent-foreground'
                                : 'hover:bg-muted/60'}`, children: [_jsx("span", { className: "truncate", children: font }), font === value ? _jsx(Check, { className: "ml-3 size-4 shrink-0" }) : null] }, font)))) : (_jsx("div", { className: "px-3 py-3 text-sm text-muted-foreground", children: "No matching fonts." })) }) }) })) : null] }));
}
