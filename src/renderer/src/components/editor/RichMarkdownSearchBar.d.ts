import React from 'react';
type RichMarkdownSearchBarProps = {
    activeMatchIndex: number;
    isOpen: boolean;
    matchCount: number;
    onClose: () => void;
    onMoveToMatch: (direction: 1 | -1) => void;
    onQueryChange: (query: string) => void;
    query: string;
    searchInputRef: React.RefObject<HTMLInputElement | null>;
};
export declare function RichMarkdownSearchBar({ activeMatchIndex, isOpen, matchCount, onClose, onMoveToMatch, onQueryChange, query, searchInputRef }: RichMarkdownSearchBarProps): React.JSX.Element | null;
export {};
