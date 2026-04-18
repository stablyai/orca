import type { Editor } from '@tiptap/react';
import type { LinkBubbleState } from './RichMarkdownLinkBubble';
/**
 * Extracts link-editing action handlers from the editor component to reduce
 * file size. State lives in the parent (declared before useEditor so the
 * editor callbacks can reference the setters).
 */
export declare function useLinkBubble(editor: Editor | null, rootRef: React.RefObject<HTMLElement | null>, linkBubble: LinkBubbleState | null, setLinkBubble: (v: LinkBubbleState | null) => void, setIsEditingLink: (v: boolean) => void): {
    handleLinkSave: (href: string) => void;
    handleLinkRemove: () => void;
    handleLinkEditCancel: () => void;
    handleLinkOpen: () => void;
    toggleLinkFromToolbar: () => void;
};
