import type { ComponentType } from 'react';
import type { ReactNodeViewProps, ReactNodeViewRendererOptions } from '@tiptap/react';
import type { NodeViewRenderer } from '@tiptap/core';
/**
 * Workaround for Tiptap #7647: ReactNodeViewRenderer's handleSelectionUpdate
 * incorrectly calls selectNode() for *any* selection that encompasses the node
 * view — including TextSelection and AllSelection from mouse drag. The
 * selectNode() call triggers a React re-render that mutates the DOM during an
 * active drag, causing ProseMirror to lose the native browser selection.
 *
 * This wrapper patches handleSelectionUpdate on each created NodeView instance
 * so selectNode/deselectNode only fire for actual NodeSelections (the user
 * clicking a node with the modifier key to select it as a whole).
 *
 * Safe to remove once Tiptap merges PR #7691.
 */
export declare function safeReactNodeViewRenderer<T = HTMLElement>(component: ComponentType<ReactNodeViewProps<T>>, options?: Partial<ReactNodeViewRendererOptions>): NodeViewRenderer;
