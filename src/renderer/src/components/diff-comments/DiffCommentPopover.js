import { jsxs as _jsxs, jsx as _jsx } from "react/jsx-runtime";
import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
export function DiffCommentPopover({ lineNumber, top, onCancel, onSubmit }) {
    const [body, setBody] = useState('');
    const textareaRef = useRef(null);
    useEffect(() => {
        textareaRef.current?.focus();
    }, []);
    const autoResize = (el) => {
        el.style.height = 'auto';
        el.style.height = `${Math.min(el.scrollHeight, 240)}px`;
    };
    const handleSubmit = () => {
        const trimmed = body.trim();
        if (!trimmed) {
            return;
        }
        onSubmit(trimmed);
    };
    return (_jsxs("div", { className: "orca-diff-comment-popover", style: { top: `${top}px` }, onMouseDown: (ev) => ev.stopPropagation(), onClick: (ev) => ev.stopPropagation(), children: [_jsxs("div", { className: "orca-diff-comment-popover-label", children: ["Line ", lineNumber] }), _jsx("textarea", { ref: textareaRef, className: "orca-diff-comment-popover-textarea", placeholder: "Add comment for the AI", value: body, onChange: (e) => {
                    setBody(e.target.value);
                    autoResize(e.currentTarget);
                }, onKeyDown: (e) => {
                    if (e.key === 'Escape') {
                        e.preventDefault();
                        onCancel();
                        return;
                    }
                    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
                        e.preventDefault();
                        handleSubmit();
                    }
                }, rows: 3 }), _jsxs("div", { className: "orca-diff-comment-popover-footer", children: [_jsx(Button, { variant: "ghost", size: "sm", onClick: onCancel, children: "Cancel" }), _jsx(Button, { size: "sm", onClick: handleSubmit, disabled: body.trim().length === 0, children: "Comment" })] })] }));
}
