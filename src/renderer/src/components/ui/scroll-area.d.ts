import * as React from 'react';
import { ScrollArea as ScrollAreaPrimitive } from 'radix-ui';
declare function ScrollArea({ className, viewportClassName, viewportRef, viewportTabIndex, children, ...props }: React.ComponentProps<typeof ScrollAreaPrimitive.Root> & {
    viewportClassName?: string;
    viewportRef?: React.Ref<HTMLDivElement>;
    /** Set e.g. -1 so the viewport can receive programmatic focus (explorer keyboard shortcuts after inline rename). */
    viewportTabIndex?: number;
}): import("react/jsx-runtime").JSX.Element;
declare function ScrollBar({ className, orientation, ...props }: React.ComponentProps<typeof ScrollAreaPrimitive.ScrollAreaScrollbar>): import("react/jsx-runtime").JSX.Element;
export { ScrollArea, ScrollBar };
