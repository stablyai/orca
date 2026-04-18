import { type RefObject } from 'react';
import type { Editor } from '@tiptap/react';
/**
 * Saves and restores scroll position for the rich markdown editor.
 * Extracted to keep the editor component under the max-lines lint limit.
 */
export declare function useEditorScrollRestore(scrollContainerRef: RefObject<HTMLDivElement | null>, scrollCacheKey: string, editor: Editor | null): void;
