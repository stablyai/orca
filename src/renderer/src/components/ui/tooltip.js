import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { Tooltip as TooltipPrimitive } from 'radix-ui';
import { cn } from '@/lib/utils';
function TooltipProvider({ delayDuration = 0, ...props }) {
    return (_jsx(TooltipPrimitive.Provider, { "data-slot": "tooltip-provider", delayDuration: delayDuration, ...props }));
}
function Tooltip({ ...props }) {
    return _jsx(TooltipPrimitive.Root, { "data-slot": "tooltip", ...props });
}
function TooltipTrigger({ ...props }) {
    return _jsx(TooltipPrimitive.Trigger, { "data-slot": "tooltip-trigger", ...props });
}
function TooltipContent({ className, sideOffset = 0, children, ...props }) {
    return (_jsx(TooltipPrimitive.Portal, { children: _jsxs(TooltipPrimitive.Content, { "data-slot": "tooltip-content", sideOffset: sideOffset, className: cn('z-50 w-fit origin-(--radix-tooltip-content-transform-origin) animate-in rounded-md bg-foreground px-3 py-1.5 text-xs text-balance text-background fade-in-0 zoom-in-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95', className), ...props, children: [children, _jsx(TooltipPrimitive.Arrow, { className: "z-50 size-2.5 translate-y-[calc(-50%_-_2px)] rotate-45 rounded-[2px] bg-foreground fill-foreground" })] }) }));
}
export { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider };
