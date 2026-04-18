import * as React from 'react';
import { HoverCard as HoverCardPrimitive } from 'radix-ui';
declare function HoverCard({ ...props }: React.ComponentProps<typeof HoverCardPrimitive.Root>): import("react/jsx-runtime").JSX.Element;
declare function HoverCardTrigger({ ...props }: React.ComponentProps<typeof HoverCardPrimitive.Trigger>): import("react/jsx-runtime").JSX.Element;
declare function HoverCardContent({ className, align, sideOffset, ...props }: React.ComponentProps<typeof HoverCardPrimitive.Content>): import("react/jsx-runtime").JSX.Element;
export { HoverCard, HoverCardTrigger, HoverCardContent };
