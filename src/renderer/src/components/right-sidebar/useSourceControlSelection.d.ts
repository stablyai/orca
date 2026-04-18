import { type RefObject } from 'react';
import type { GitStatusEntry } from '../../../../shared/types';
export type FlatEntry = {
    key: string;
    entry: GitStatusEntry;
    area: 'unstaged' | 'staged' | 'untracked';
};
export declare function reconcileSelectionKeys(selectedKeys: ReadonlySet<string>, flatEntries: FlatEntry[]): Set<string>;
export declare function getSelectionRangeKeys(flatEntries: FlatEntry[], anchorKey: string | null, currentKey: string): Set<string> | null;
export declare function useSourceControlSelection({ flatEntries, onOpenDiff, containerRef }: {
    flatEntries: FlatEntry[];
    onOpenDiff: (entry: GitStatusEntry) => void;
    containerRef: RefObject<HTMLElement | null>;
}): {
    selectedKeys: Set<string>;
    handleSelect: (e: React.MouseEvent, key: string, entry: GitStatusEntry) => void;
    handleContextMenu: (key: string) => void;
    clearSelection: () => void;
};
