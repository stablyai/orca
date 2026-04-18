import * as React from 'react';
import { Command as CommandPrimitive } from 'cmdk';
import { Dialog as DialogPrimitive } from 'radix-ui';
declare function Command({ className, ...props }: React.ComponentProps<typeof CommandPrimitive>): import("react/jsx-runtime").JSX.Element;
declare function CommandDialog({ children, title, description, shouldFilter, onOpenAutoFocus, onCloseAutoFocus, contentClassName, overlayClassName, commandProps, ...props }: React.ComponentProps<typeof DialogPrimitive.Root> & {
    title?: string;
    description?: string;
    shouldFilter?: boolean;
    onOpenAutoFocus?: (e: Event) => void;
    onCloseAutoFocus?: (e: Event) => void;
    contentClassName?: string;
    overlayClassName?: string;
    commandProps?: React.ComponentProps<typeof CommandPrimitive>;
}): import("react/jsx-runtime").JSX.Element;
declare function CommandInput({ className, wrapperClassName, iconClassName, ...props }: React.ComponentProps<typeof CommandPrimitive.Input> & {
    wrapperClassName?: string;
    iconClassName?: string;
}): import("react/jsx-runtime").JSX.Element;
declare function CommandList({ className, ...props }: React.ComponentProps<typeof CommandPrimitive.List>): import("react/jsx-runtime").JSX.Element;
declare function CommandEmpty({ className, ...props }: React.ComponentProps<typeof CommandPrimitive.Empty>): import("react/jsx-runtime").JSX.Element;
declare function CommandGroup({ className, ...props }: React.ComponentProps<typeof CommandPrimitive.Group>): import("react/jsx-runtime").JSX.Element;
declare function CommandItem({ className, ...props }: React.ComponentProps<typeof CommandPrimitive.Item>): import("react/jsx-runtime").JSX.Element;
declare function CommandSeparator({ className, ...props }: React.ComponentProps<typeof CommandPrimitive.Separator>): import("react/jsx-runtime").JSX.Element;
export { Command, CommandDialog, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList, CommandSeparator };
