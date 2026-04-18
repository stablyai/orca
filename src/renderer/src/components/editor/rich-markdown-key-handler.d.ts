import type { MutableRefObject, Dispatch, SetStateAction } from 'react';
import type { Editor } from '@tiptap/react';
import { type LinkBubbleState } from './RichMarkdownLinkBubble';
import { type SlashCommand, type SlashMenuState } from './rich-markdown-commands';
export type KeyHandlerContext = {
    isMac: boolean;
    editorRef: MutableRefObject<Editor | null>;
    rootRef: MutableRefObject<HTMLDivElement | null>;
    lastCommittedMarkdownRef: MutableRefObject<string>;
    onContentChangeRef: MutableRefObject<(content: string) => void>;
    onSaveRef: MutableRefObject<(content: string) => void>;
    isEditingLinkRef: MutableRefObject<boolean>;
    slashMenuRef: MutableRefObject<SlashMenuState | null>;
    filteredSlashCommandsRef: MutableRefObject<SlashCommand[]>;
    selectedCommandIndexRef: MutableRefObject<number>;
    handleLocalImagePickRef: MutableRefObject<() => void>;
    flushPendingSerialization: () => void;
    openSearchRef: MutableRefObject<() => void>;
    setIsEditingLink: (editing: boolean) => void;
    setLinkBubble: (bubble: LinkBubbleState | null) => void;
    setSelectedCommandIndex: Dispatch<SetStateAction<number>>;
    setSlashMenu: (menu: SlashMenuState | null) => void;
};
/**
 * Why: extracted from RichMarkdownEditor to stay under the file line-limit
 * while keeping the keyboard handler logic co-located and testable.
 */
export declare function createRichMarkdownKeyHandler(ctx: KeyHandlerContext): (_view: unknown, event: KeyboardEvent) => boolean;
