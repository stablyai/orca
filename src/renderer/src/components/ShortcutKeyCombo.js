import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import React from 'react';
function KeyCap({ label }) {
    return (_jsx("span", { className: "inline-flex min-w-6 items-center justify-center rounded border border-border/80 bg-secondary/70 px-1.5 py-0.5 text-xs font-medium text-muted-foreground shadow-sm", children: label }));
}
export function ShortcutKeyCombo({ keys, separatorClassName }) {
    const isMac = navigator.userAgent.includes('Mac');
    return (_jsx("div", { className: "flex items-center gap-1", children: keys.map((key, index) => (_jsxs(React.Fragment, { children: [_jsx(KeyCap, { label: key }), !isMac && index < keys.length - 1 ? (_jsx("span", { className: separatorClassName ?? 'mx-0.5 text-xs text-muted-foreground', children: "+" })) : null] }, `${key}-${index}`))) }));
}
