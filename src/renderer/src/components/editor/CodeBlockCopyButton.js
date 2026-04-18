import { jsx as _jsx, Fragment as _Fragment, jsxs as _jsxs } from "react/jsx-runtime";
import React, { useCallback, useState } from 'react';
import { Copy, Check } from 'lucide-react';
export default function CodeBlockCopyButton({ children, ...props }) {
    const [copied, setCopied] = useState(false);
    const handleCopy = useCallback(() => {
        // Extract the text content from the nested <code> element rendered by
        // react-markdown inside <pre>. We walk the React children tree to grab the
        // raw string so clipboard receives plain text, not markup.
        let text = '';
        React.Children.forEach(children, (child) => {
            if (React.isValidElement(child) && child.props) {
                const inner = child.props.children;
                text += typeof inner === 'string' ? inner : extractText(inner);
            }
            else if (typeof child === 'string') {
                text += child;
            }
        });
        void window.api.ui
            .writeClipboardText(text)
            .then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
        })
            .catch(() => {
            // Silently swallow clipboard write failures (e.g. permission denied).
        });
    }, [children]);
    return (_jsxs("div", { className: "code-block-wrapper", children: [_jsx("pre", { ...props, children: children }), _jsx("button", { type: "button", className: "code-block-copy-btn", onClick: handleCopy, "aria-label": "Copy code", title: "Copy code", children: copied ? (_jsxs(_Fragment, { children: [_jsx(Check, { size: 14 }), _jsx("span", { className: "code-block-copy-label", children: "Copied" })] })) : (_jsx(Copy, { size: 14 })) })] }));
}
/** Recursively extract text from React children. */
function extractText(node) {
    if (typeof node === 'string' || typeof node === 'number') {
        return String(node);
    }
    if (Array.isArray(node)) {
        return node.map(extractText).join('');
    }
    if (React.isValidElement(node) && node.props) {
        return extractText(node.props.children);
    }
    return '';
}
