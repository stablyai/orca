import React from 'react';
import type { Editor } from '@tiptap/react';
export type LinkBubbleState = {
    href: string;
    left: number;
    top: number;
};
export declare function getLinkBubblePosition(editor: Editor, rootEl: HTMLElement | null): {
    left: number;
    top: number;
} | null;
type RichMarkdownLinkBubbleProps = {
    linkBubble: LinkBubbleState;
    isEditing: boolean;
    onSave: (href: string) => void;
    onRemove: () => void;
    onEditStart: () => void;
    onEditCancel: () => void;
    onOpen: () => void;
};
export declare function RichMarkdownLinkBubble({ linkBubble, isEditing, onSave, onRemove, onEditStart, onEditCancel, onOpen }: RichMarkdownLinkBubbleProps): React.JSX.Element;
export {};
