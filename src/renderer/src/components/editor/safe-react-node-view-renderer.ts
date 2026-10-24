import type { ComponentType } from 'react'
import { ReactNodeViewRenderer } from '@tiptap/react'
import type { ReactNodeViewProps, ReactNodeViewRendererOptions } from '@tiptap/react'
import type { NodeViewRenderer } from '@tiptap/core'
import { NodeSelection } from '@tiptap/pm/state'

/** Work around Tiptap #7647 until #7691 ships in our dependency: restrict selection rerenders to NodeSelection so native drags survive. */
export function safeReactNodeViewRenderer<T = HTMLElement>(
  component: ComponentType<ReactNodeViewProps<T>>,
  options?: Partial<ReactNodeViewRendererOptions>
): NodeViewRenderer {
  const factory = ReactNodeViewRenderer(component, options)

  return (props) => {
    const nodeView = factory(props)

    // The factory returns an empty object before contentComponent exists, leaving no selection callback to patch.
    if (!('handleSelectionUpdate' in nodeView)) {
      return nodeView
    }

    // Replace the registered bound callback too; storing the patch back on the instance also lets destroy unsubscribe correctly.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const nv = nodeView as any
    const originalBound = nv.handleSelectionUpdate
    nv.editor.off('selectionUpdate', originalBound)

    nv.handleSelectionUpdate = function patchedHandleSelectionUpdate(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      this: any
    ): void {
      // Text/AllSelection can span nodes during a drag; rerendering them would disrupt native selection tracking.
      if (this.editor.state.selection instanceof NodeSelection) {
        originalBound()
      } else {
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
