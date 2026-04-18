import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { Copy, Image, MessageSquarePlus, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
// ---------------------------------------------------------------------------
// Grab payload → human-readable prompt context
// ---------------------------------------------------------------------------
export function formatGrabPayloadAsText(payload) {
    const lines = [];
    lines.push(`Attached browser context from ${payload.page.sanitizedUrl}`);
    lines.push('');
    // Selected element summary
    lines.push('Selected element:');
    lines.push(payload.target.tagName);
    if (payload.target.accessibility.accessibleName) {
        lines.push(`Accessible name: "${payload.target.accessibility.accessibleName}"`);
    }
    if (payload.target.accessibility.role) {
        lines.push(`Role: ${payload.target.accessibility.role}`);
    }
    lines.push(`Selector: ${payload.target.selector}`);
    const { rectViewport } = payload.target;
    lines.push(`Dimensions: ${Math.round(rectViewport.width)}x${Math.round(rectViewport.height)}`);
    lines.push('');
    // Text snippet
    if (payload.target.textSnippet) {
        lines.push('Text content:');
        lines.push(payload.target.textSnippet);
        lines.push('');
    }
    // Nearby context
    if (payload.nearbyText.length > 0) {
        lines.push('Nearby context:');
        for (const text of payload.nearbyText) {
            lines.push(`- ${text}`);
        }
        lines.push('');
    }
    // Computed styles
    const styles = payload.target.computedStyles;
    const styleLines = [];
    if (styles.display && styles.display !== 'inline') {
        styleLines.push(`display: ${styles.display}`);
    }
    if (styles.position && styles.position !== 'static') {
        styleLines.push(`position: ${styles.position}`);
    }
    if (styles.fontSize) {
        styleLines.push(`font-size: ${styles.fontSize}`);
    }
    if (styles.color) {
        styleLines.push(`color: ${styles.color}`);
    }
    if (styles.backgroundColor && styles.backgroundColor !== 'rgba(0, 0, 0, 0)') {
        styleLines.push(`background: ${styles.backgroundColor}`);
    }
    if (styleLines.length > 0) {
        lines.push('Computed styles:');
        for (const sl of styleLines) {
            lines.push(`  ${sl}`);
        }
        lines.push('');
    }
    // HTML snippet
    if (payload.target.htmlSnippet) {
        lines.push('HTML:');
        lines.push(payload.target.htmlSnippet);
        lines.push('');
    }
    // Ancestor path
    if (payload.ancestorPath.length > 0) {
        lines.push(`Ancestor path: ${payload.ancestorPath.join(' > ')}`);
    }
    return lines.join('\n').trimEnd();
}
// ---------------------------------------------------------------------------
// Security: all page-derived strings are rendered as escaped plain text.
// No innerHTML, no markdown rendering, no auto-linking.
// ---------------------------------------------------------------------------
function EscapedText({ text, className }) {
    return _jsx("span", { className: className, children: text });
}
// ---------------------------------------------------------------------------
// Confirmation Sheet Component
// ---------------------------------------------------------------------------
export default function GrabConfirmationSheet({ payload, onCopy, onCopyScreenshot, onAttach, onCancel }) {
    const { target, page, nearbyText } = payload;
    return (_jsxs("div", { className: "absolute inset-0 z-20 flex flex-col bg-background/98 backdrop-blur-sm", children: [_jsxs("div", { className: "flex items-center justify-between border-b border-border/70 px-4 py-3", children: [_jsxs("div", { className: "flex items-center gap-2", children: [_jsx("div", { className: "rounded-md bg-indigo-500/10 px-2 py-0.5 text-xs font-medium text-indigo-400", children: "Grab" }), _jsx("span", { className: "text-sm text-muted-foreground", children: "Review before attaching. Captured page context may include visible site content." })] }), _jsx(Button, { size: "icon", variant: "ghost", className: "h-7 w-7", onClick: onCancel, children: _jsx(X, { className: "size-4" }) })] }), _jsx(ScrollArea, { className: "flex-1 p-4", children: _jsxs("div", { className: "space-y-4", children: [payload.screenshot?.dataUrl?.startsWith('data:image/png;base64,') ? (_jsx("div", { className: "overflow-hidden rounded-lg border border-border/60", children: _jsx("img", { src: payload.screenshot.dataUrl, alt: "Selected element screenshot", className: "max-h-48 w-full object-contain bg-black/5" }) })) : null, _jsxs("div", { className: "space-y-2", children: [_jsx("h3", { className: "text-xs font-semibold uppercase tracking-wider text-muted-foreground", children: "Selected Element" }), _jsxs("div", { className: "rounded-lg border border-border/60 bg-muted/20 p-3 text-sm", children: [_jsxs("div", { className: "flex items-baseline gap-2", children: [_jsx("span", { className: "font-mono font-semibold text-foreground", children: _jsx(EscapedText, { text: `<${target.tagName}>` }) }), target.accessibility.role ? (_jsxs("span", { className: "text-xs text-muted-foreground", children: ["role=", _jsx(EscapedText, { text: target.accessibility.role })] })) : null] }), target.accessibility.accessibleName ? (_jsxs("div", { className: "mt-1 text-muted-foreground", children: ["\"", _jsx(EscapedText, { text: target.accessibility.accessibleName }), "\""] })) : null, _jsx("div", { className: "mt-1 font-mono text-xs text-muted-foreground/70", children: _jsx(EscapedText, { text: target.selector }) }), _jsxs("div", { className: "mt-1 text-xs text-muted-foreground/60", children: [Math.round(target.rectViewport.width), "x", Math.round(target.rectViewport.height)] })] })] }), _jsxs("div", { className: "space-y-2", children: [_jsx("h3", { className: "text-xs font-semibold uppercase tracking-wider text-muted-foreground", children: "Page" }), _jsxs("div", { className: "rounded-lg border border-border/60 bg-muted/20 p-3 text-sm", children: [_jsx("div", { className: "font-medium text-foreground", children: _jsx(EscapedText, { text: page.title || 'Untitled' }) }), _jsx("div", { className: "mt-0.5 text-xs text-muted-foreground/70", children: _jsx(EscapedText, { text: page.sanitizedUrl }) })] })] }), target.htmlSnippet ? (_jsxs("div", { className: "space-y-2", children: [_jsx("h3", { className: "text-xs font-semibold uppercase tracking-wider text-muted-foreground", children: "HTML" }), _jsx("pre", { className: "max-h-32 overflow-auto rounded-lg border border-border/60 bg-muted/20 p-3 font-mono text-xs text-foreground/80", children: _jsx(EscapedText, { text: target.htmlSnippet }) })] })) : null, nearbyText.length > 0 ? (_jsxs("div", { className: "space-y-2", children: [_jsx("h3", { className: "text-xs font-semibold uppercase tracking-wider text-muted-foreground", children: "Nearby Context" }), _jsx("div", { className: "rounded-lg border border-border/60 bg-muted/20 p-3", children: _jsx("ul", { className: "list-inside list-disc space-y-0.5 text-sm text-muted-foreground", children: nearbyText.map((text, i) => (_jsx("li", { children: _jsx(EscapedText, { text: text }) }, i))) }) })] })) : null] }) }), _jsxs("div", { className: "flex items-center justify-end gap-2 border-t border-border/70 px-4 py-3", children: [_jsx(Button, { variant: "ghost", size: "sm", onClick: onCancel, children: "Cancel" }), _jsxs(Button, { variant: "outline", size: "sm", className: "gap-1.5", onClick: onCopy, children: [_jsx(Copy, { className: "size-3.5" }), "Copy"] }), onCopyScreenshot ? (_jsxs(Button, { variant: "outline", size: "sm", className: "gap-1.5", onClick: onCopyScreenshot, children: [_jsx(Image, { className: "size-3.5" }), "Copy Screenshot"] })) : null, _jsxs(Button, { size: "sm", className: "gap-1.5", onClick: onAttach, children: [_jsx(MessageSquarePlus, { className: "size-3.5" }), "Attach to AI"] })] })] }));
}
