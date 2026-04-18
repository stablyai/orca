import type { RefObject } from 'react';
import type { Editor } from '@tiptap/react';
export declare function useRichMarkdownSearch({ editor, isMac, rootRef }: {
    editor: Editor | null;
    isMac: boolean;
    rootRef: RefObject<HTMLDivElement | null>;
}): {
    activeMatchIndex: number;
    closeSearch: () => void;
    isSearchOpen: boolean;
    matchCount: number;
    moveToMatch: (direction: 1 | -1) => void;
    openSearch: () => void;
    searchInputRef: RefObject<HTMLInputElement | null>;
    searchQuery: string;
    setSearchQuery: import("react").Dispatch<import("react").SetStateAction<string>>;
};
