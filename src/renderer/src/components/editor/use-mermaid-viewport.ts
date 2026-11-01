import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { listenMarkdownPreviewScrollInput } from './markdown-preview-scroll-input'

const MERMAID_PRELOAD_MARGIN_PX = 600
const diagramRenderers = new WeakMap<Element, () => Promise<void>>()
const pendingNavigations = new WeakMap<HTMLElement, () => void>()

export function renderMermaidDiagrams(root: Element): Promise<void> | undefined {
  const pending: Promise<void>[] = []
  for (const element of root.querySelectorAll('[data-mermaid-lazy]')) {
    const render = diagramRenderers.get(element)
    if (render) {
      pending.push(render())
    }
  }
  return pending.length > 0 ? Promise.all(pending).then(() => {}) : undefined
}

export function cancelMermaidNavigation(root: HTMLElement): void {
  const cancel = pendingNavigations.get(root)
  pendingNavigations.delete(root)
  cancel?.()
}

export function registerMermaidNavigation(root: HTMLElement, cancel: () => void): () => void {
  pendingNavigations.set(root, cancel)
  return () => {
    if (pendingNavigations.get(root) === cancel) {
      pendingNavigations.delete(root)
    }
  }
}

export function settleMermaidNavigation(
  root: HTMLElement,
  reveal: () => void,
  target?: Element
): (() => void) | undefined {
  cancelMermaidNavigation(root)
  const viewport = root.getBoundingClientRect()
  const top = target?.getBoundingClientRect().top ?? viewport.top
  const pending: Promise<void>[] = []
  for (const element of root.querySelectorAll('[data-mermaid-lazy]')) {
    const render = diagramRenderers.get(element)
    // Chromium can retain layout boxes inside closed <details>.
    if (
      !render ||
      element.getClientRects().length === 0 ||
      (typeof element.checkVisibility === 'function' && !element.checkVisibility())
    ) {
      continue
    }
    const bounds = element.getBoundingClientRect()
    if (
      bounds.bottom >= top - MERMAID_PRELOAD_MARGIN_PX &&
      bounds.top <= top + viewport.height + MERMAID_PRELOAD_MARGIN_PX
    ) {
      pending.push(render())
    }
  }
  if (pending.length === 0) {
    return
  }
  let cancelled = false
  const cancel = (): void => {
    cancelled = true
    stopListening()
    unregister()
  }
  const stopListening = listenMarkdownPreviewScrollInput(root, cancel, {
    cancelEditableInput: root.closest('.rich-markdown-editor-shell') !== null
  })
  const unregister = registerMermaidNavigation(root, cancel)
  void Promise.all(pending)
    .then(() => {
      if (!cancelled && root.isConnected) {
        reveal()
      }
    })
    .finally(() => {
      stopListening()
      unregister()
    })
  return cancel
}

export function useMermaidViewport(lazy: boolean, ready: boolean) {
  const ref = useRef<HTMLDivElement>(null)
  const [enteredViewport, setEnteredViewport] = useState(false)
  const pendingRender = useRef<PromiseWithResolvers<void> | null>(null)
  const previousHeight = useRef<number | null>(null)

  useEffect(() => {
    const element = ref.current
    if (!lazy || enteredViewport || !element) {
      return
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setEnteredViewport(true)
          observer.disconnect()
        }
      },
      {
        root: element.closest('.markdown-preview, .rich-markdown-editor-shell .overflow-auto'),
        rootMargin: `${MERMAID_PRELOAD_MARGIN_PX}px 0px`
      }
    )
    observer.observe(element)
    return () => observer.disconnect()
  }, [lazy, enteredViewport])

  useLayoutEffect(() => {
    const element = ref.current
    if (!lazy || !enteredViewport || !element) {
      return
    }
    const container = element.closest<HTMLElement>('.rich-markdown-editor-shell .overflow-auto')
    if (!container) {
      return
    }
    const bounds = element.getBoundingClientRect()
    const height = previousHeight.current
    previousHeight.current = bounds.height
    if (!ready || height === null || bounds.top + height > container.getBoundingClientRect().top) {
      return
    }
    const adjustment = bounds.height - height
    if (adjustment < 0 && container.scrollTop >= container.scrollHeight - container.clientHeight) {
      return
    }
    container.scrollTop += adjustment
  }, [enteredViewport, lazy, ready])

  useLayoutEffect(() => {
    if (ready) {
      pendingRender.current?.resolve()
      pendingRender.current = null
    }
  }, [ready])

  useLayoutEffect(() => {
    const element = ref.current
    if (!lazy || !element || ready) {
      return
    }
    diagramRenderers.set(element, () => {
      setEnteredViewport(true)
      pendingRender.current ??= Promise.withResolvers<void>()
      return pendingRender.current.promise
    })
    return () => {
      diagramRenderers.delete(element)
    }
  }, [lazy, ready])

  useLayoutEffect(
    () => () => {
      pendingRender.current?.resolve()
    },
    []
  )

  return { ref, renderEnabled: !lazy || enteredViewport }
}
