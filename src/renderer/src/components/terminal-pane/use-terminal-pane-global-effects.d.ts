import type { PaneManager } from '@/lib/pane-manager/pane-manager';
import type { PtyTransport } from './pty-transport';
type UseTerminalPaneGlobalEffectsArgs = {
    tabId: string;
    isActive: boolean;
    isVisible: boolean;
    managerRef: React.RefObject<PaneManager | null>;
    containerRef: React.RefObject<HTMLDivElement | null>;
    paneTransportsRef: React.RefObject<Map<number, PtyTransport>>;
    pendingWritesRef: React.RefObject<Map<number, string>>;
    isActiveRef: React.RefObject<boolean>;
    isVisibleRef: React.RefObject<boolean>;
    toggleExpandPane: (paneId: number) => void;
};
export declare function useTerminalPaneGlobalEffects({ tabId, isActive, isVisible, managerRef, containerRef, paneTransportsRef, pendingWritesRef, isActiveRef, isVisibleRef, toggleExpandPane }: UseTerminalPaneGlobalEffectsArgs): void;
export {};
