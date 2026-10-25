import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type DragEvent,
  type RefObject
} from 'react'
import { readConversationReferenceDrag } from '@/lib/conversation-reference-drag'
import { CONVERSATION_REFERENCE_DRAG_TYPE } from '../../../../shared/conversation-reference'
import type { NativeChatComposerInput } from './native-chat-composer-input'
import {
  addConversationReferenceToComposer,
  isConversationReferencePending,
  registerConversationReferenceComposer,
  subscribeToConversationReferencePending,
  type ConversationReferenceComposer
} from './conversation-reference-insertion'

export type ConversationReferenceDropArgs = {
  scope: string
  input: RefObject<NativeChatComposerInput | null>
  disabled: boolean
  composing: () => boolean
  targetEnvironmentId?: string
}

/** A composer's drop target for conversation references; `ref` also offers it to menus. */
export function useConversationReferenceDrop({
  scope,
  input,
  disabled,
  composing,
  targetEnvironmentId
}: ConversationReferenceDropArgs) {
  const [hover, setHover] = useState(false)
  const element = useRef<HTMLElement | null>(null)
  const live = useRef({ scope, disabled, composing, targetEnvironmentId })
  useLayoutEffect(() => {
    live.current = { scope, disabled, composing, targetEnvironmentId }
  })
  const composer = useMemo<ConversationReferenceComposer>(
    () => ({
      scope: () => live.current.scope,
      input,
      element: () => element.current,
      environmentId: () => live.current.targetEnvironmentId,
      disabled: () => live.current.disabled,
      composing: () => live.current.composing()
    }),
    [input]
  )
  useEffect(() => registerConversationReferenceComposer(composer), [composer])
  const pending = useSyncExternalStore(subscribeToConversationReferencePending, () =>
    isConversationReferencePending(scope)
  )
  const ref = useCallback((node: HTMLElement | null) => {
    element.current = node
  }, [])
  const hasReference = (event: DragEvent): boolean =>
    Array.from(event.dataTransfer.types).includes(CONVERSATION_REFERENCE_DRAG_TYPE)
  return {
    ref,
    pending,
    hover,
    onDragOver: (event: DragEvent<HTMLDivElement>) => {
      if (!hasReference(event)) {
        return
      }
      event.preventDefault()
      event.stopPropagation()
      event.dataTransfer.dropEffect = disabled || composing() ? 'none' : 'copy'
      setHover(!disabled && !composing())
    },
    onDragLeave: (event: DragEvent<HTMLDivElement>) => {
      if (
        !(event.relatedTarget instanceof Node) ||
        !event.currentTarget.contains(event.relatedTarget)
      ) {
        setHover(false)
      }
    },
    onDrop: (event: DragEvent<HTMLDivElement>) => {
      if (!hasReference(event)) {
        return
      }
      event.preventDefault()
      event.stopPropagation()
      setHover(false)
      if (disabled || composing()) {
        return
      }
      const source = readConversationReferenceDrag(event.dataTransfer)
      if (source) {
        void addConversationReferenceToComposer(composer, source)
      }
    }
  }
}
