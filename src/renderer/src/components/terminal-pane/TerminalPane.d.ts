/** Global set of buffer-capture callbacks, one per mounted TerminalPane.
 *  The beforeunload handler in App.tsx invokes every callback to populate
 *  Zustand with serialized buffers before flushing the session to disk. */
export declare const shutdownBufferCaptures: Set<() => void>;
type TerminalPaneProps = {
    tabId: string;
    worktreeId: string;
    cwd?: string;
    isActive: boolean;
    isVisible?: boolean;
    onPtyExit: (ptyId: string) => void;
    onCloseTab: () => void;
};
export default function TerminalPane({ tabId, worktreeId, cwd, isActive, isVisible, onPtyExit, onCloseTab }: TerminalPaneProps): React.JSX.Element;
export {};
