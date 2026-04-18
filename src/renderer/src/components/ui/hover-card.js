'use client';
import { jsx as _jsx } from "react/jsx-runtime";
import { HoverCard as HoverCardPrimitive } from 'radix-ui';
import { cn } from '@/lib/utils';
function HoverCard({ ...props }) {
    return _jsx(HoverCardPrimitive.Root, { "data-slot": "hover-card", ...props });
}
function HoverCardTrigger({ ...props }) {
    return _jsx(HoverCardPrimitive.Trigger, { "data-slot": "hover-card-trigger", ...props });
}
function HoverCardContent({ className, align = 'center', sideOffset = 4, ...props }) {
    return (_jsx(HoverCardPrimitive.Portal, { "data-slot": "hover-card-portal", children: _jsx(HoverCardPrimitive.Content, { "data-slot": "hover-card-content", align: align, sideOffset: sideOffset, className: cn('z-50 w-64 origin-(--radix-hover-card-content-transform-origin) rounded-md border border-border/50 bg-popover p-4 text-popover-foreground shadow-md outline-hidden data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95 data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95', className), ...props }) }));
}
export { HoverCard, HoverCardTrigger, HoverCardContent };
