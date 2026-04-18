import type { IDisposable, ILinkProvider } from '@xterm/xterm';
import type { PaneManager } from '@/lib/pane-manager/pane-manager';
export type LinkHandlerDeps = {
    worktreeId: string;
    worktreePath: string;
    startupCwd: string;
    managerRef: React.RefObject<PaneManager | null>;
    linkProviderDisposablesRef: React.RefObject<Map<number, IDisposable>>;
    pathExistsCache: Map<string, boolean>;
};
type TerminalLinkEvent = Pick<MouseEvent, 'metaKey' | 'ctrlKey'> & Partial<Pick<MouseEvent, 'shiftKey' | 'preventDefault' | 'stopPropagation'>>;
export declare function getTerminalFileOpenHint(): string;
export declare function getTerminalUrlOpenHint(): string;
export declare function openDetectedFilePath(filePath: string, line: number | null, column: number | null, deps: Pick<LinkHandlerDeps, 'worktreeId' | 'worktreePath'>): void;
export declare function createFilePathLinkProvider(paneId: number, deps: LinkHandlerDeps, linkTooltip: HTMLElement, openLinkHint: string): ILinkProvider;
export declare function isTerminalLinkActivation(event: Pick<MouseEvent, 'metaKey' | 'ctrlKey'> | undefined): boolean;
export declare function handleOscLink(rawText: string, event: TerminalLinkEvent | undefined, deps: Pick<LinkHandlerDeps, 'worktreeId' | 'worktreePath'>): void;
export {};
