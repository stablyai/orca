import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { CheckIcon, ChevronRightIcon, CircleIcon } from 'lucide-react';
import { ContextMenu as ContextMenuPrimitive } from 'radix-ui';
import { cn } from '@/lib/utils';
function ContextMenu({ ...props }) {
    return _jsx(ContextMenuPrimitive.Root, { "data-slot": "context-menu", modal: false, ...props });
}
function ContextMenuTrigger({ ...props }) {
    return _jsx(ContextMenuPrimitive.Trigger, { "data-slot": "context-menu-trigger", ...props });
}
function ContextMenuGroup({ ...props }) {
    return _jsx(ContextMenuPrimitive.Group, { "data-slot": "context-menu-group", ...props });
}
function ContextMenuPortal({ ...props }) {
    return _jsx(ContextMenuPrimitive.Portal, { "data-slot": "context-menu-portal", ...props });
}
function ContextMenuSub({ ...props }) {
    return _jsx(ContextMenuPrimitive.Sub, { "data-slot": "context-menu-sub", ...props });
}
function ContextMenuRadioGroup({ ...props }) {
    return _jsx(ContextMenuPrimitive.RadioGroup, { "data-slot": "context-menu-radio-group", ...props });
}
function ContextMenuSubTrigger({ className, inset, children, ...props }) {
    return (_jsxs(ContextMenuPrimitive.SubTrigger, { "data-slot": "context-menu-sub-trigger", "data-inset": inset, className: cn("flex cursor-default items-center rounded-[7px] px-2 py-1 text-[12px] leading-5 font-[450] outline-hidden select-none focus:bg-black/8 dark:focus:bg-white/14 focus:text-accent-foreground data-[inset]:pl-8 data-[state=open]:bg-black/8 dark:data-[state=open]:bg-white/14 data-[state=open]:text-accent-foreground [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-3.5 [&_svg:not([class*='text-'])]:text-muted-foreground", className), ...props, children: [children, _jsx(ChevronRightIcon, { className: "ml-auto" })] }));
}
function ContextMenuSubContent({ className, ...props }) {
    return (_jsx(ContextMenuPrimitive.SubContent, { "data-slot": "context-menu-sub-content", className: cn('z-50 min-w-[11rem] origin-(--radix-context-menu-content-transform-origin) overflow-hidden rounded-[11px] border border-black/14 bg-[rgba(255,255,255,0.10)] p-1 text-popover-foreground shadow-[0_16px_36px_rgba(0,0,0,0.24),inset_0_1px_0_rgba(255,255,255,0.14)] backdrop-blur-2xl dark:border-white/14 dark:bg-[rgba(0,0,0,0.12)] dark:shadow-[0_20px_44px_rgba(0,0,0,0.42),inset_0_1px_0_rgba(255,255,255,0.04)] data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95 data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95', className), ...props }));
}
function ContextMenuContent({ className, ...props }) {
    return (_jsx(ContextMenuPrimitive.Portal, { children: _jsx(ContextMenuPrimitive.Content, { "data-slot": "context-menu-content", className: cn('z-50 max-h-(--radix-context-menu-content-available-height) min-w-[11rem] origin-(--radix-context-menu-content-transform-origin) overflow-x-hidden overflow-y-auto rounded-[11px] border border-black/14 bg-[rgba(255,255,255,0.10)] p-1 text-popover-foreground shadow-[0_16px_36px_rgba(0,0,0,0.24),inset_0_1px_0_rgba(255,255,255,0.14)] backdrop-blur-2xl dark:border-white/14 dark:bg-[rgba(0,0,0,0.12)] dark:shadow-[0_20px_44px_rgba(0,0,0,0.42),inset_0_1px_0_rgba(255,255,255,0.04)] data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95 data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95', className), ...props }) }));
}
function ContextMenuItem({ className, inset, variant = 'default', ...props }) {
    return (_jsx(ContextMenuPrimitive.Item, { "data-slot": "context-menu-item", "data-inset": inset, "data-variant": variant, className: cn("relative flex cursor-default items-center gap-2 rounded-[7px] px-2 py-1 text-[12px] leading-5 font-[450] outline-hidden select-none focus:bg-black/8 dark:focus:bg-white/14 focus:text-accent-foreground data-[disabled]:pointer-events-none data-[disabled]:opacity-50 data-[inset]:pl-8 data-[variant=destructive]:text-destructive data-[variant=destructive]:focus:bg-destructive/10 data-[variant=destructive]:focus:text-destructive dark:data-[variant=destructive]:focus:bg-destructive/20 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-3.5 [&_svg:not([class*='text-'])]:text-muted-foreground data-[variant=destructive]:*:[svg]:text-destructive!", className), ...props }));
}
function ContextMenuCheckboxItem({ className, children, checked, ...props }) {
    return (_jsxs(ContextMenuPrimitive.CheckboxItem, { "data-slot": "context-menu-checkbox-item", className: cn("relative flex cursor-default items-center gap-2 rounded-[7px] py-1 pr-2 pl-8 text-[12px] leading-5 font-[450] outline-hidden select-none focus:bg-black/8 dark:focus:bg-white/14 focus:text-accent-foreground data-[disabled]:pointer-events-none data-[disabled]:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-3.5", className), checked: checked, ...props, children: [_jsx("span", { className: "pointer-events-none absolute left-2 flex size-3.5 items-center justify-center", children: _jsx(ContextMenuPrimitive.ItemIndicator, { children: _jsx(CheckIcon, { className: "size-4" }) }) }), children] }));
}
function ContextMenuRadioItem({ className, children, ...props }) {
    return (_jsxs(ContextMenuPrimitive.RadioItem, { "data-slot": "context-menu-radio-item", className: cn("relative flex cursor-default items-center gap-2 rounded-[7px] py-1 pr-2 pl-8 text-[12px] leading-5 font-[450] outline-hidden select-none focus:bg-black/8 dark:focus:bg-white/14 focus:text-accent-foreground data-[disabled]:pointer-events-none data-[disabled]:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-3.5", className), ...props, children: [_jsx("span", { className: "pointer-events-none absolute left-2 flex size-3.5 items-center justify-center", children: _jsx(ContextMenuPrimitive.ItemIndicator, { children: _jsx(CircleIcon, { className: "size-2 fill-current" }) }) }), children] }));
}
function ContextMenuLabel({ className, inset, ...props }) {
    return (_jsx(ContextMenuPrimitive.Label, { "data-slot": "context-menu-label", "data-inset": inset, className: cn('px-2 py-1 text-[11px] font-semibold text-muted-foreground data-[inset]:pl-8', className), ...props }));
}
function ContextMenuSeparator({ className, ...props }) {
    return (_jsx(ContextMenuPrimitive.Separator, { "data-slot": "context-menu-separator", className: cn('my-1 h-px bg-border/70', className), ...props }));
}
function ContextMenuShortcut({ className, ...props }) {
    return (_jsx("span", { "data-slot": "context-menu-shortcut", className: cn('ml-auto text-[11px] tracking-normal text-muted-foreground/85', className), ...props }));
}
export { ContextMenu, ContextMenuTrigger, ContextMenuContent, ContextMenuItem, ContextMenuCheckboxItem, ContextMenuRadioItem, ContextMenuLabel, ContextMenuSeparator, ContextMenuShortcut, ContextMenuGroup, ContextMenuPortal, ContextMenuSub, ContextMenuSubContent, ContextMenuSubTrigger, ContextMenuRadioGroup };
