import * as React from 'react';
import { ContextMenu as ContextMenuPrimitive } from 'radix-ui';
declare function ContextMenu({ ...props }: React.ComponentProps<typeof ContextMenuPrimitive.Root>): import("react/jsx-runtime").JSX.Element;
declare function ContextMenuTrigger({ ...props }: React.ComponentProps<typeof ContextMenuPrimitive.Trigger>): import("react/jsx-runtime").JSX.Element;
declare function ContextMenuGroup({ ...props }: React.ComponentProps<typeof ContextMenuPrimitive.Group>): import("react/jsx-runtime").JSX.Element;
declare function ContextMenuPortal({ ...props }: React.ComponentProps<typeof ContextMenuPrimitive.Portal>): import("react/jsx-runtime").JSX.Element;
declare function ContextMenuSub({ ...props }: React.ComponentProps<typeof ContextMenuPrimitive.Sub>): import("react/jsx-runtime").JSX.Element;
declare function ContextMenuRadioGroup({ ...props }: React.ComponentProps<typeof ContextMenuPrimitive.RadioGroup>): import("react/jsx-runtime").JSX.Element;
declare function ContextMenuSubTrigger({ className, inset, children, ...props }: React.ComponentProps<typeof ContextMenuPrimitive.SubTrigger> & {
    inset?: boolean;
}): import("react/jsx-runtime").JSX.Element;
declare function ContextMenuSubContent({ className, ...props }: React.ComponentProps<typeof ContextMenuPrimitive.SubContent>): import("react/jsx-runtime").JSX.Element;
declare function ContextMenuContent({ className, ...props }: React.ComponentProps<typeof ContextMenuPrimitive.Content>): import("react/jsx-runtime").JSX.Element;
declare function ContextMenuItem({ className, inset, variant, ...props }: React.ComponentProps<typeof ContextMenuPrimitive.Item> & {
    inset?: boolean;
    variant?: 'default' | 'destructive';
}): import("react/jsx-runtime").JSX.Element;
declare function ContextMenuCheckboxItem({ className, children, checked, ...props }: React.ComponentProps<typeof ContextMenuPrimitive.CheckboxItem>): import("react/jsx-runtime").JSX.Element;
declare function ContextMenuRadioItem({ className, children, ...props }: React.ComponentProps<typeof ContextMenuPrimitive.RadioItem>): import("react/jsx-runtime").JSX.Element;
declare function ContextMenuLabel({ className, inset, ...props }: React.ComponentProps<typeof ContextMenuPrimitive.Label> & {
    inset?: boolean;
}): import("react/jsx-runtime").JSX.Element;
declare function ContextMenuSeparator({ className, ...props }: React.ComponentProps<typeof ContextMenuPrimitive.Separator>): import("react/jsx-runtime").JSX.Element;
declare function ContextMenuShortcut({ className, ...props }: React.ComponentProps<'span'>): import("react/jsx-runtime").JSX.Element;
export { ContextMenu, ContextMenuTrigger, ContextMenuContent, ContextMenuItem, ContextMenuCheckboxItem, ContextMenuRadioItem, ContextMenuLabel, ContextMenuSeparator, ContextMenuShortcut, ContextMenuGroup, ContextMenuPortal, ContextMenuSub, ContextMenuSubContent, ContextMenuSubTrigger, ContextMenuRadioGroup };
