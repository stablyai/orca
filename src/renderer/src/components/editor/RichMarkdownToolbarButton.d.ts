import React from 'react';
type RichMarkdownToolbarButtonProps = {
    active: boolean;
    label: string;
    onClick: () => void;
    children: React.ReactNode;
};
export declare function RichMarkdownToolbarButton({ active, label, onClick, children }: RichMarkdownToolbarButtonProps): React.JSX.Element;
export {};
