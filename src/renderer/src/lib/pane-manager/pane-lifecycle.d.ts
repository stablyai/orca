import type { ITerminalOptions } from '@xterm/xterm';
import type { PaneManagerOptions, ManagedPaneInternal } from './pane-manager-types';
import type { DragReorderState } from './pane-drag-reorder';
import type { DragReorderCallbacks } from './pane-drag-reorder';
export declare function buildDefaultTerminalOptions(): ITerminalOptions;
export declare function createPaneDOM(id: number, options: PaneManagerOptions, dragState: DragReorderState, dragCallbacks: DragReorderCallbacks, onPointerDown: (id: number) => void, onMouseEnter: (id: number, event: MouseEvent) => void): ManagedPaneInternal;
/** Open terminal into its container and load addons. Must be called after the container is in the DOM. */
export declare function openTerminal(pane: ManagedPaneInternal): void;
export declare function attachWebgl(pane: ManagedPaneInternal): void;
export declare function disposePane(pane: ManagedPaneInternal, panes: Map<number, ManagedPaneInternal>): void;
