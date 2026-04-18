import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { cn } from '@/lib/utils';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
export function RichMarkdownToolbarButton({ active, label, onClick, children }) {
    return (_jsx(TooltipProvider, { children: _jsxs(Tooltip, { children: [_jsx(TooltipTrigger, { asChild: true, children: _jsx("button", { type: "button", className: cn('rich-markdown-toolbar-button', active && 'is-active'), "aria-label": label, onMouseDown: (event) => event.preventDefault(), onClick: onClick, children: children }) }), _jsx(TooltipContent, { side: "bottom", sideOffset: 4, children: label })] }) }));
}
