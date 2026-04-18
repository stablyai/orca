import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { CheckIcon, ChevronRightIcon, CircleIcon } from 'lucide-react';
import { DropdownMenu as DropdownMenuPrimitive } from 'radix-ui';
import { cn } from '@/lib/utils';
function DropdownMenu({ ...props }) {
    return _jsx(DropdownMenuPrimitive.Root, { "data-slot": "dropdown-menu", ...props });
}
function DropdownMenuPortal({ ...props }) {
    return _jsx(DropdownMenuPrimitive.Portal, { "data-slot": "dropdown-menu-portal", ...props });
}
function DropdownMenuTrigger({ ...props }) {
    return _jsx(DropdownMenuPrimitive.Trigger, { "data-slot": "dropdown-menu-trigger", ...props });
}
function DropdownMenuContent({ className, sideOffset = 4, ...props }) {
    return (_jsx(DropdownMenuPrimitive.Portal, { children: _jsx(DropdownMenuPrimitive.Content, { "data-slot": "dropdown-menu-content", sideOffset: sideOffset, className: cn('z-50 max-h-(--radix-dropdown-menu-content-available-height) min-w-[11rem] origin-(--radix-dropdown-menu-content-transform-origin) overflow-x-hidden overflow-y-auto rounded-[11px] border border-black/14 bg-[rgba(255,255,255,0.82)] p-1 text-black dark:text-white shadow-[0_16px_36px_rgba(0,0,0,0.24),inset_0_1px_0_rgba(255,255,255,0.14)] backdrop-blur-2xl dark:border-white/14 dark:bg-[rgba(0,0,0,0.72)] dark:shadow-[0_20px_44px_rgba(0,0,0,0.42),inset_0_1px_0_rgba(255,255,255,0.04)] data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95 data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95', className), ...props }) }));
}
function DropdownMenuGroup({ ...props }) {
    return _jsx(DropdownMenuPrimitive.Group, { "data-slot": "dropdown-menu-group", ...props });
}
function DropdownMenuItem({ className, inset, variant = 'default', ...props }) {
    return (_jsx(DropdownMenuPrimitive.Item, { "data-slot": "dropdown-menu-item", "data-inset": inset, "data-variant": variant, className: cn("relative flex cursor-default items-center gap-2 rounded-[7px] px-2 py-0.5 text-[12px] leading-5 font-medium outline-hidden select-none focus:bg-black/8 dark:focus:bg-white/14 focus:text-accent-foreground data-[disabled]:pointer-events-none data-[disabled]:opacity-50 data-[inset]:pl-7 data-[variant=destructive]:text-destructive data-[variant=destructive]:focus:bg-destructive/10 data-[variant=destructive]:focus:text-destructive dark:data-[variant=destructive]:focus:bg-destructive/20 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-3.5 [&_svg:not([class*='text-'])]:text-muted-foreground data-[variant=destructive]:*:[svg]:text-destructive!", className), ...props }));
}
function DropdownMenuCheckboxItem({ className, children, checked, ...props }) {
    return (_jsxs(DropdownMenuPrimitive.CheckboxItem, { "data-slot": "dropdown-menu-checkbox-item", className: cn("relative flex cursor-default items-center gap-2 rounded-[7px] py-1 pr-2 pl-7 text-[12px] leading-5 font-medium outline-hidden select-none focus:bg-black/8 dark:focus:bg-white/14 focus:text-accent-foreground data-[disabled]:pointer-events-none data-[disabled]:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-3.5", className), checked: checked, ...props, children: [_jsx("span", { className: "pointer-events-none absolute left-2 flex size-3.5 items-center justify-center", children: _jsx(DropdownMenuPrimitive.ItemIndicator, { children: _jsx(CheckIcon, { className: "size-4" }) }) }), children] }));
}
function DropdownMenuRadioGroup({ ...props }) {
    return _jsx(DropdownMenuPrimitive.RadioGroup, { "data-slot": "dropdown-menu-radio-group", ...props });
}
function DropdownMenuRadioItem({ className, children, ...props }) {
    return (_jsxs(DropdownMenuPrimitive.RadioItem, { "data-slot": "dropdown-menu-radio-item", className: cn("relative flex cursor-default items-center gap-2 rounded-[7px] py-1 pr-2 pl-7 text-[12px] leading-5 font-medium outline-hidden select-none focus:bg-black/8 dark:focus:bg-white/14 focus:text-accent-foreground data-[disabled]:pointer-events-none data-[disabled]:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-3.5", className), ...props, children: [_jsx("span", { className: "pointer-events-none absolute left-2 flex size-3.5 items-center justify-center", children: _jsx(DropdownMenuPrimitive.ItemIndicator, { children: _jsx(CircleIcon, { className: "size-2 fill-current" }) }) }), children] }));
}
function DropdownMenuLabel({ className, inset, ...props }) {
    return (_jsx(DropdownMenuPrimitive.Label, { "data-slot": "dropdown-menu-label", "data-inset": inset, className: cn('px-2 py-1 text-[11px] font-semibold text-muted-foreground data-[inset]:pl-7', className), ...props }));
}
function DropdownMenuSeparator({ className, ...props }) {
    return (_jsx(DropdownMenuPrimitive.Separator, { "data-slot": "dropdown-menu-separator", className: cn('my-1 h-px bg-border/70', className), ...props }));
}
function DropdownMenuShortcut({ className, ...props }) {
    return (_jsx("span", { "data-slot": "dropdown-menu-shortcut", className: cn('ml-auto text-[11px] tracking-normal text-muted-foreground/85', className), ...props }));
}
function DropdownMenuSub({ ...props }) {
    return _jsx(DropdownMenuPrimitive.Sub, { "data-slot": "dropdown-menu-sub", ...props });
}
function DropdownMenuSubTrigger({ className, inset, children, ...props }) {
    return (_jsxs(DropdownMenuPrimitive.SubTrigger, { "data-slot": "dropdown-menu-sub-trigger", "data-inset": inset, className: cn("flex cursor-default items-center gap-2 rounded-[7px] px-2 py-0.5 text-[12px] leading-5 font-medium outline-hidden select-none focus:bg-black/8 dark:focus:bg-white/14 focus:text-accent-foreground data-[inset]:pl-7 data-[state=open]:bg-black/8 dark:data-[state=open]:bg-white/14 data-[state=open]:text-accent-foreground [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-3.5 [&_svg:not([class*='text-'])]:text-muted-foreground", className), ...props, children: [children, _jsx(ChevronRightIcon, { className: "ml-auto size-4" })] }));
}
function DropdownMenuSubContent({ className, ...props }) {
    return (_jsx(DropdownMenuPrimitive.SubContent, { "data-slot": "dropdown-menu-sub-content", className: cn('z-50 min-w-[11rem] origin-(--radix-dropdown-menu-content-transform-origin) overflow-hidden rounded-[11px] border border-black/14 bg-[rgba(255,255,255,0.82)] p-1 text-black dark:text-white shadow-[0_16px_36px_rgba(0,0,0,0.24),inset_0_1px_0_rgba(255,255,255,0.14)] backdrop-blur-2xl dark:border-white/14 dark:bg-[rgba(0,0,0,0.72)] dark:shadow-[0_20px_44px_rgba(0,0,0,0.42),inset_0_1px_0_rgba(255,255,255,0.04)] data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95 data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95', className), ...props }));
}
export { DropdownMenu, DropdownMenuPortal, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuGroup, DropdownMenuLabel, DropdownMenuItem, DropdownMenuCheckboxItem, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuSeparator, DropdownMenuShortcut, DropdownMenuSub, DropdownMenuSubTrigger, DropdownMenuSubContent };
