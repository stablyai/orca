'use client';
import { jsx as _jsx } from "react/jsx-runtime";
import { Popover as PopoverPrimitive } from 'radix-ui';
import { cn } from '@/lib/utils';
function Popover(props) {
    return _jsx(PopoverPrimitive.Root, { "data-slot": "popover", ...props });
}
function PopoverTrigger(props) {
    return _jsx(PopoverPrimitive.Trigger, { "data-slot": "popover-trigger", ...props });
}
function PopoverContent({ className, align = 'center', sideOffset = 4, ...props }) {
    return (_jsx(PopoverPrimitive.Portal, { children: _jsx(PopoverPrimitive.Content, { "data-slot": "popover-content", align: align, sideOffset: sideOffset, className: cn('z-[60] rounded-md border border-border/50 bg-popover text-popover-foreground shadow-md outline-none data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95 data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95', className), ...props }) }));
}
export { Popover, PopoverContent, PopoverTrigger };
