import React from 'react';
import type { Editor } from '@tiptap/react';
export type SlashMenuState = {
    query: string;
    from: number;
    to: number;
    left: number;
    top: number;
};
export type SlashCommandId = 'text' | 'heading-1' | 'heading-2' | 'heading-3' | 'task-list' | 'bullet-list' | 'ordered-list' | 'blockquote' | 'code-block' | 'divider' | 'image';
export type SlashCommand = {
    id: SlashCommandId;
    label: string;
    aliases: string[];
    icon: React.ComponentType<{
        className?: string;
    }>;
    description: string;
    run: (editor: Editor) => void;
};
/**
 * Executes a slash command by first deleting the typed slash text, then
 * delegating to the command's run method. Image is special-cased because
 * window.prompt() is not supported in Electron's renderer process.
 */
export declare function runSlashCommand(editor: Editor, slashMenu: {
    from: number;
    to: number;
}, command: SlashCommand, onImageCommand?: () => void): void;
export declare const slashCommands: SlashCommand[];
/**
 * Inspects the editor selection to decide whether the slash-command menu
 * should be open (and where to position it), or dismissed.
 */
export declare function syncSlashMenu(editor: Editor, root: HTMLDivElement | null, setSlashMenu: React.Dispatch<React.SetStateAction<SlashMenuState | null>>): void;
