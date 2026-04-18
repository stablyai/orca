import type { PaneManager } from '@/lib/pane-manager/pane-manager';
type FontZoomDeps = {
    isActive: boolean;
    managerRef: React.RefObject<PaneManager | null>;
    paneFontSizesRef: React.RefObject<Map<number, number>>;
    settingsRef: React.RefObject<{
        terminalFontSize?: number;
    } | null>;
};
export declare function useTerminalFontZoom({ isActive, managerRef, paneFontSizesRef, settingsRef }: FontZoomDeps): void;
export {};
