import type { ComponentType } from 'react'
import { ReactNodeViewRenderer } from '@tiptap/react'
import type { ReactNodeViewProps, ReactNodeViewRendererOptions } from '@tiptap/react'
import type { NodeViewRenderer } from '@tiptap/core'
import { NodeSelection } from '@tiptap/pm/state'

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
export function safeReactNodeViewRenderer<T = HTMLElement>(
  component: ComponentType<ReactNodeViewProps<T>>,
  options?: Partial<ReactNodeViewRendererOptions>
): NodeViewRenderer {
  const factory = ReactNodeViewRenderer(component, options)

  return (props) => {
    const nodeView = factory(props)

    // Why: the factory returns an empty object when editor.contentComponent
    // is not set (SSR / immediatelyRender: false initial pass). In that case
    // there is no handleSelectionUpdate to patch.
    if (!('handleSelectionUpdate' in nodeView)) {
      return nodeView
    }

    // Why: the constructor binds handleSelectionUpdate and registers it via
    // editor.on('selectionUpdate', ...). We must unregister the original bound
    // reference before replacing, otherwise the event emitter still calls the
    // original and our patch is a no-op. On destroy(), the class calls
    // editor.off('selectionUpdate', this.handleSelectionUpdate), so storing
    // the patched function back on the property ensures clean teardown.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const nv = nodeView as any
    const originalBound = nv.handleSelectionUpdate
    nv.editor.off('selectionUpdate', originalBound)

    nv.handleSelectionUpdate = function patchedHandleSelectionUpdate(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      this: any
    ): void {
      // Why: only NodeSelection means the user intentionally selected this
      // specific node (e.g. Ctrl/Cmd-click on an atom node). Text and All
      // selections that happen to span across the node should not trigger
      // selectNode(), because that causes a React re-render mid-drag which
      // disrupts the browser's native selection tracking.
      if (this.editor.state.selection instanceof NodeSelection) {
        originalBound()
      } else {
        // Why: if a previous NodeSelection had set selected=true, clear it
        // now that the selection is no longer a NodeSelection.
        if (this.renderer?.props?.selected) {
          this.deselectNode()
        }
      }
    }

    nv.handleSelectionUpdate = nv.handleSelectionUpdate.bind(nv)
    nv.editor.on('selectionUpdate', nv.handleSelectionUpdate)

    return nodeView
  }
}
