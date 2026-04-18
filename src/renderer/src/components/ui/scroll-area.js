import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { ScrollArea as ScrollAreaPrimitive } from 'radix-ui';
import { cn } from '@/lib/utils';
function ScrollArea({ className, viewportClassName, viewportRef, viewportTabIndex, children, ...props }) {
    return (_jsxs(ScrollAreaPrimitive.Root, { "data-slot": "scroll-area", className: cn('relative', className), ...props, children: [_jsx(ScrollAreaPrimitive.Viewport, { ref: viewportRef, tabIndex: viewportTabIndex, "data-slot": "scroll-area-viewport", className: cn('size-full rounded-[inherit] transition-[color,box-shadow] outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-1', viewportClassName), children: children }), _jsx(ScrollBar, {}), _jsx(ScrollAreaPrimitive.Corner, {})] }));
}
function ScrollBar({ className, orientation = 'vertical', ...props }) {
    return (_jsx(ScrollAreaPrimitive.ScrollAreaScrollbar, { "data-slot": "scroll-area-scrollbar", orientation: orientation, className: cn('flex touch-none p-px transition-colors select-none bg-transparent', orientation === 'vertical' && 'h-full w-3 py-2 border-l border-l-transparent', orientation === 'horizontal' && 'h-3 px-2 flex-col border-t border-t-transparent', className), ...props, children: _jsx(ScrollAreaPrimitive.ScrollAreaThumb, { "data-slot": "scroll-area-thumb", className: "relative flex-1 rounded-full bg-muted-foreground/40 hover:bg-muted-foreground/60" }) }));
}
export { ScrollArea, ScrollBar };
