import { useCallback, useLayoutEffect, useRef, useState, type RefObject } from 'react'
import type { Editor } from '@tiptap/react'
import { attachRichMarkdownViewport } from './rich-markdown-viewport'

export function useRichMarkdownViewport(
  editor: Editor | null,
  key: string,
  rootRef: RefObject<HTMLDivElement | null>,
  containerRef: RefObject<HTMLDivElement | null>
) {
  const [root, setRoot] = useState<HTMLDivElement | null>(null)
  const [container, setContainer] = useState<HTMLDivElement | null>(null)
  const cleanup = useRef<(() => void) | null>(null)
  const retire = useCallback(() => {
    cleanup.current?.()
    cleanup.current = null
  }, [])
  const bindRoot = useCallback(
    (node: HTMLDivElement | null) => {
      if (node !== rootRef.current) {
        retire()
      }
      rootRef.current = node
      setRoot(node)
    },
    [rootRef, retire]
  )
  const bindContainer = useCallback(
    (node: HTMLDivElement | null) => {
      if (node !== containerRef.current) {
        retire()
      }
      containerRef.current = node
      setContainer(node)
    },
    [containerRef, retire]
  )
  useLayoutEffect(() => {
    if (editor && !editor.isDestroyed && root && container) {
      cleanup.current = attachRichMarkdownViewport(editor, root, container)
    }
    return retire
  }, [editor, key, root, container, retire])
  return { bindRoot, bindContainer }
}
