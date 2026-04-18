import React from 'react';
import type { Editor } from '@tiptap/react';
import type { SlashCommand, SlashMenuState } from './rich-markdown-commands';
type RichMarkdownSlashMenuProps = {
    editor: Editor | null;
    slashMenu: SlashMenuState;
    filteredCommands: SlashCommand[];
    selectedIndex: number;
    onImagePick: () => void;
};
export declare function RichMarkdownSlashMenu({ editor, slashMenu, filteredCommands, selectedIndex, onImagePick }: RichMarkdownSlashMenuProps): React.JSX.Element;
export {};
