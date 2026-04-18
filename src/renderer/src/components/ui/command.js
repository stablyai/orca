'use client';
import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { Command as CommandPrimitive } from 'cmdk';
import { SearchIcon } from 'lucide-react';
import { Dialog as DialogPrimitive } from 'radix-ui';
import { cn } from '@/lib/utils';
function Command({ className, ...props }) {
    return (_jsx(CommandPrimitive, { "data-slot": "command", className: cn('flex h-full w-full flex-col overflow-hidden rounded-md bg-popover text-popover-foreground', className), ...props }));
}
function CommandDialog({ children, title = 'Command Palette', description = 'Search for a command to run...', shouldFilter, onOpenAutoFocus, onCloseAutoFocus, contentClassName, overlayClassName, commandProps, ...props }) {
    const { className: commandClassName, ...commandRootProps } = commandProps ?? {};
    return (_jsx(DialogPrimitive.Root, { ...props, children: _jsxs(DialogPrimitive.Portal, { children: [_jsx(DialogPrimitive.Overlay, { className: cn('fixed inset-0 z-50 bg-black/50 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:animate-in data-[state=open]:fade-in-0', overlayClassName) }), _jsxs(DialogPrimitive.Content, { className: cn('fixed top-[20%] left-[50%] z-50 w-[660px] max-w-[90vw] translate-x-[-50%] rounded-lg border border-border bg-popover shadow-lg outline-none data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95 data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95', contentClassName), onOpenAutoFocus: onOpenAutoFocus, onCloseAutoFocus: onCloseAutoFocus, children: [_jsx(DialogPrimitive.Title, { className: "sr-only", children: title }), _jsx(DialogPrimitive.Description, { className: "sr-only", children: description }), _jsx(Command, { shouldFilter: shouldFilter, className: cn('[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:text-muted-foreground [&_[cmdk-group]:not([hidden])_~[cmdk-group]]:pt-0 [&_[cmdk-input-wrapper]_svg]:h-5 [&_[cmdk-input-wrapper]_svg]:w-5 [&_[cmdk-input]]:h-12 [&_[cmdk-item]]:px-2 [&_[cmdk-item]]:py-3', commandClassName), ...commandRootProps, children: children })] })] }) }));
}
function CommandInput({ className, wrapperClassName, iconClassName, ...props }) {
    return (_jsxs("div", { className: cn('flex items-center border-b border-border px-3', wrapperClassName), "data-cmdk-input-wrapper": "", children: [_jsx(SearchIcon, { className: cn('mr-2 h-4 w-4 shrink-0 opacity-50', iconClassName) }), _jsx(CommandPrimitive.Input, { "data-slot": "command-input", className: cn('flex h-10 w-full rounded-md bg-transparent py-3 text-sm outline-none placeholder:text-muted-foreground disabled:cursor-not-allowed disabled:opacity-50', className), ...props })] }));
}
function CommandList({ className, ...props }) {
    return (_jsx(CommandPrimitive.List, { "data-slot": "command-list", className: cn('max-h-[min(400px,60vh)] overflow-y-auto overflow-x-hidden scrollbar-sleek scroll-pb-4 scroll-pt-4', className), ...props }));
}
function CommandEmpty({ className, ...props }) {
    return (_jsx(CommandPrimitive.Empty, { "data-slot": "command-empty", className: cn('py-6 text-center text-sm text-muted-foreground', className), ...props }));
}
function CommandGroup({ className, ...props }) {
    return (_jsx(CommandPrimitive.Group, { "data-slot": "command-group", className: cn('overflow-hidden p-1 text-foreground [&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1.5 [&_[cmdk-group-heading]]:text-xs [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:text-muted-foreground', className), ...props }));
}
function CommandItem({ className, ...props }) {
    return (_jsx(CommandPrimitive.Item, { "data-slot": "command-item", className: cn('relative flex cursor-default gap-2 select-none items-center rounded-sm px-2 py-1.5 text-sm outline-none data-[selected=true]:bg-accent data-[selected=true]:text-accent-foreground data-[disabled=true]:pointer-events-none data-[disabled=true]:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*="size-"])]:size-4', className), ...props }));
}
function CommandSeparator({ className, ...props }) {
    return (_jsx(CommandPrimitive.Separator, { "data-slot": "command-separator", className: cn('-mx-1 h-px bg-border', className), ...props }));
}
export { Command, CommandDialog, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList, CommandSeparator };
