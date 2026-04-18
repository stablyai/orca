import type { PaneManager } from '@/lib/pane-manager/pane-manager';
import type { GlobalSettings } from '../../../../shared/types';
import type { PtyTransport } from './pty-transport';
export declare function applyTerminalAppearance(manager: PaneManager, settings: GlobalSettings, systemPrefersDark: boolean, paneFontSizes: Map<number, number>, paneTransports: Map<number, PtyTransport>): void;
