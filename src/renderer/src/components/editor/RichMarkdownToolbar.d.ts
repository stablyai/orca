import React from 'react';
import type { Editor } from '@tiptap/react';
type RichMarkdownToolbarProps = {
    editor: Editor | null;
    onToggleLink: () => void;
    onImagePick: () => void;
};
export declare function RichMarkdownToolbar({ editor, onToggleLink, onImagePick }: RichMarkdownToolbarProps): React.JSX.Element;
export {};
