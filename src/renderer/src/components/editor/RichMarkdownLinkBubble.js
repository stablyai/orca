import { jsx as _jsx, Fragment as _Fragment, jsxs as _jsxs } from "react/jsx-runtime";
import { useEffect, useRef, useState } from 'react';
import { ExternalLink, Pencil, Unlink } from 'lucide-react';
export function getLinkBubblePosition(editor, rootEl) {
    const { from } = editor.state.selection;
    try {
        const coords = editor.view.coordsAtPos(from);
        const rootRect = rootEl?.getBoundingClientRect();
        if (!rootRect) {
            return null;
        }
        return {
            left: coords.left - rootRect.left,
            top: coords.bottom - rootRect.top + 4
        };
    }
    catch {
        return null;
    }
}
function LinkEditInput({ initialHref, onSave, onCancel }) {
    const [value, setValue] = useState(initialHref);
    const ref = useRef(null);
    useEffect(() => {
        ref.current?.focus();
        ref.current?.select();
    }, []);
    return (_jsx("input", { ref: ref, value: value, onChange: (e) => setValue(e.target.value), onKeyDown: (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                onSave(value.trim());
            }
            if (e.key === 'Escape') {
                e.preventDefault();
                onCancel();
            }
            // Cmd/Ctrl+K while editing cancels the edit.
            if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
                e.preventDefault();
                onCancel();
            }
        }, placeholder: "Paste or type a link\u2026", className: "rich-markdown-link-input" }));
}
export function RichMarkdownLinkBubble({ linkBubble, isEditing, onSave, onRemove, onEditStart, onEditCancel, onOpen }) {
    return (_jsx("div", { className: "rich-markdown-link-bubble", style: { left: linkBubble.left, top: linkBubble.top }, onMouseDown: (e) => {
            // Prevent editor blur when clicking bubble buttons, but let inputs
            // receive focus normally.
            if (!(e.target instanceof HTMLInputElement)) {
                e.preventDefault();
            }
        }, onKeyDown: (e) => e.stopPropagation(), children: isEditing ? (_jsx(LinkEditInput, { initialHref: linkBubble.href, onSave: onSave, onCancel: onEditCancel })) : (_jsxs(_Fragment, { children: [_jsx("span", { className: "rich-markdown-link-url", title: linkBubble.href, children: linkBubble.href.length > 40 ? `${linkBubble.href.slice(0, 40)}…` : linkBubble.href }), _jsx("button", { type: "button", className: "rich-markdown-link-button", onClick: onOpen, title: "Open link", children: _jsx(ExternalLink, { size: 14 }) }), _jsx("button", { type: "button", className: "rich-markdown-link-button", onClick: onEditStart, title: "Edit link", children: _jsx(Pencil, { size: 14 }) }), _jsx("button", { type: "button", className: "rich-markdown-link-button", onClick: onRemove, title: "Remove link", children: _jsx(Unlink, { size: 14 }) })] })) }));
}
