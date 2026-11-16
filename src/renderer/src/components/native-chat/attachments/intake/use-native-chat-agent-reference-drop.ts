import { useCallback } from 'react'
import type { DragEventHandler } from 'react'
import {
  hasAgentReferenceDragData,
  readAgentReferenceDragData
} from '@/lib/agent-session/messaging/agent-reference-drag'
import type { NativeChatComposerHandle } from '../../composer/native-chat-composer-types'

type Args = {
  disabled: boolean
  insertAgentReferences: NativeChatComposerHandle['insertAgentReferences']
}

/** An agent row dragged from the sidebar lands in the draft as the crew panel's Mention does. */
export function useNativeChatAgentReferenceDrop({ disabled, insertAgentReferences }: Args): {
  onDragOverCapture: DragEventHandler<HTMLDivElement>
  onDropCapture: DragEventHandler<HTMLDivElement>
} {
  const onDragOverCapture = useCallback<DragEventHandler<HTMLDivElement>>(
    (event) => {
      if (!hasAgentReferenceDragData(event.dataTransfer)) {
        return
      }
      event.preventDefault()
      event.stopPropagation()
      event.dataTransfer.dropEffect = disabled ? 'none' : 'copy'
    },
    [disabled]
  )
  const onDropCapture = useCallback<DragEventHandler<HTMLDivElement>>(
    (event) => {
      if (!hasAgentReferenceDragData(event.dataTransfer)) {
        return
      }
      event.preventDefault()
      event.stopPropagation()
      const reference = disabled ? null : readAgentReferenceDragData(event.dataTransfer)
      if (reference) {
        insertAgentReferences([reference])
      }
    },
    [disabled, insertAgentReferences]
  )
  return { onDragOverCapture, onDropCapture }
}
