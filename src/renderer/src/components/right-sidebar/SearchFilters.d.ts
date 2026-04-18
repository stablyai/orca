import React from 'react';
type SearchFiltersProps = {
    includePattern: string;
    excludePattern: string;
    onIncludeChange: (value: string) => void;
    onExcludeChange: (value: string) => void;
    includeInputRef?: React.RefObject<HTMLInputElement | null>;
    excludeInputRef?: React.RefObject<HTMLInputElement | null>;
};
export declare function SearchFilters({ includePattern, excludePattern, onIncludeChange, onExcludeChange, includeInputRef, excludeInputRef }: SearchFiltersProps): React.JSX.Element;
export {};
