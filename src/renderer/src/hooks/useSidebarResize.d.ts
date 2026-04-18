import React from 'react';
type UseSidebarResizeOptions = {
    isOpen: boolean;
    width: number;
    minWidth: number;
    maxWidth: number;
    deltaSign: 1 | -1;
    renderedExtraWidth?: number;
    setWidth: (width: number) => void;
};
type UseSidebarResizeResult<T extends HTMLElement> = {
    containerRef: React.RefObject<T | null>;
    isResizing: boolean;
    onResizeStart: (event: React.MouseEvent) => void;
};
export declare function clampSidebarResizeWidth(width: number, minWidth: number, maxWidth: number): number;
export declare function getRenderedSidebarWidthCssValue(isOpen: boolean, width: number, renderedExtraWidth: number): string;
export declare function getNextSidebarResizeWidth({ clientX, startX, startWidth, deltaSign, minWidth, maxWidth }: {
    clientX: number;
    startX: number;
    startWidth: number;
    deltaSign: 1 | -1;
    minWidth: number;
    maxWidth: number;
}): number;
export declare function useSidebarResize<T extends HTMLElement>({ isOpen, width, minWidth, maxWidth, deltaSign, renderedExtraWidth, setWidth }: UseSidebarResizeOptions): UseSidebarResizeResult<T>;
export {};
