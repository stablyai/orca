import * as React from 'react';
import { Popover as PopoverPrimitive } from 'radix-ui';
declare function Popover(props: React.ComponentProps<typeof PopoverPrimitive.Root>): import("react/jsx-runtime").JSX.Element;
declare function PopoverTrigger(props: React.ComponentProps<typeof PopoverPrimitive.Trigger>): import("react/jsx-runtime").JSX.Element;
declare function PopoverContent({ className, align, sideOffset, ...props }: React.ComponentProps<typeof PopoverPrimitive.Content>): import("react/jsx-runtime").JSX.Element;
export { Popover, PopoverContent, PopoverTrigger };
