import type { Node as ProseMirrorNode } from '@tiptap/pm/model';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { DecorationSet } from '@tiptap/pm/view';
export type RichMarkdownSearchMatch = {
    from: number;
    to: number;
};
type RichMarkdownSearchState = {
    activeIndex: number;
    decorations: DecorationSet;
    query: string;
};
export declare const richMarkdownSearchPluginKey: PluginKey<RichMarkdownSearchState>;
export declare function findRichMarkdownSearchMatches(doc: ProseMirrorNode, query: string): RichMarkdownSearchMatch[];
export declare function createRichMarkdownSearchPlugin(): Plugin<RichMarkdownSearchState>;
export {};
