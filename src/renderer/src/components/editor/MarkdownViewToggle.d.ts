import React from 'react';
import type { MarkdownViewMode } from '@/store/slices/editor';
type MarkdownViewToggleProps = {
    mode: MarkdownViewMode;
    onChange: (mode: MarkdownViewMode) => void;
};
export default function MarkdownViewToggle({ mode, onChange }: MarkdownViewToggleProps): React.JSX.Element;
export {};
