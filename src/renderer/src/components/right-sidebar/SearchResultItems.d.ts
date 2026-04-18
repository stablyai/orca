import React from 'react';
import type { SearchFileResult, SearchMatch } from '../../../../shared/types';
export declare function ToggleButton({ active, onClick, title, children, ariaExpanded }: {
    active: boolean;
    onClick: () => void;
    title: string;
    children: React.ReactNode;
    ariaExpanded?: boolean;
}): React.JSX.Element;
export declare function FileResultRow({ fileResult, onToggleCollapse, collapsed }: {
    fileResult: SearchFileResult;
    onToggleCollapse: () => void;
    collapsed: boolean;
}): React.JSX.Element;
export declare function MatchResultRow({ match, relativePath, onClick }: {
    match: SearchMatch;
    relativePath: string;
    onClick: () => void;
}): React.JSX.Element;
