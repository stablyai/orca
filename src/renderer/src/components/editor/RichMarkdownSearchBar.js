import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { ChevronDown, ChevronUp, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
export function RichMarkdownSearchBar({ activeMatchIndex, isOpen, matchCount, onClose, onMoveToMatch, onQueryChange, query, searchInputRef }) {
    if (!isOpen) {
        return null;
    }
    const keepSearchFocus = (event) => {
        // Why: rich-mode find drives navigation through the ProseMirror selection.
        // Letting the toolbar buttons take focus interrupts that selection flow and
        // makes mouse-based next/previous navigation appear broken.
        event.preventDefault();
    };
    return (_jsxs("div", { className: "rich-markdown-search", onKeyDown: (event) => event.stopPropagation(), children: [_jsx("div", { className: "rich-markdown-search-field", children: _jsx(Input, { ref: searchInputRef, value: query, onChange: (event) => onQueryChange(event.target.value), onKeyDown: (event) => {
                        if (event.key === 'Enter' && event.shiftKey) {
                            event.preventDefault();
                            onMoveToMatch(-1);
                            return;
                        }
                        if (event.key === 'Enter') {
                            event.preventDefault();
                            onMoveToMatch(1);
                            return;
                        }
                        if (event.key === 'Escape') {
                            event.preventDefault();
                            onClose();
                        }
                    }, placeholder: "Find in rich editor", className: "rich-markdown-search-input h-7 !border-0 bg-transparent px-2 shadow-none focus-visible:!border-0 focus-visible:ring-0", "aria-label": "Find in rich markdown editor" }) }), _jsx("div", { className: "rich-markdown-search-status", children: query && matchCount === 0
                    ? 'No results'
                    : `${matchCount === 0 ? 0 : activeMatchIndex + 1}/${matchCount}` }), _jsx(Button, { type: "button", variant: "ghost", size: "icon-xs", onMouseDown: keepSearchFocus, onClick: () => onMoveToMatch(-1), disabled: matchCount === 0, title: "Previous match", "aria-label": "Previous match", className: "rich-markdown-search-button", children: _jsx(ChevronUp, { size: 14 }) }), _jsx(Button, { type: "button", variant: "ghost", size: "icon-xs", onMouseDown: keepSearchFocus, onClick: () => onMoveToMatch(1), disabled: matchCount === 0, title: "Next match", "aria-label": "Next match", className: "rich-markdown-search-button", children: _jsx(ChevronDown, { size: 14 }) }), _jsx("div", { className: "rich-markdown-search-divider" }), _jsx(Button, { type: "button", variant: "ghost", size: "icon-xs", onMouseDown: keepSearchFocus, onClick: onClose, title: "Close search", "aria-label": "Close search", className: "rich-markdown-search-button", children: _jsx(X, { size: 14 }) })] }));
}
