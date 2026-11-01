import { scrollTopCache, setWithLRU } from '@/lib/scroll-cache'
import { listenMarkdownPreviewScrollInput } from './markdown-preview-scroll-input'
import {
  cancelMermaidNavigation,
  registerMermaidNavigation,
  settleMermaidNavigation
} from './use-mermaid-viewport'

type MarkdownScrollAnchor = {
  path: number[]
  tagName: string
  offset: number
  diagramCount: number
}
const anchors = new Map<string, MarkdownScrollAnchor>()

export function clearMarkdownMermaidScrollAnchor(key: string): void {
  anchors.delete(key)
}

function firstVisibleChild(parent: Element, top: number): number {
  let start = 0
  let end = parent.children.length
  while (start < end) {
    const middle = (start + end) >>> 1
    if (parent.children[middle].getBoundingClientRect().bottom <= top) {
      start = middle + 1
    } else {
      end = middle
    }
  }
  return start
}

export function recordMarkdownMermaidScrollAnchor(
  container: HTMLElement,
  body: Element | null,
  key: string
): void {
  if (!body || body.children.length === 0) {
    return
  }
  const diagramCount = body.querySelectorAll('[data-mermaid-lazy]').length
  if (diagramCount === 0) {
    anchors.delete(key)
    return
  }
  const top = container.getBoundingClientRect().top
  const path: number[] = []
  let parent = body
  let target: Element | null = null
  while (parent.children.length > 0) {
    const index = parent.classList.contains('markdown-annotation-block')
      ? 0
      : firstVisibleChild(parent, top)
    const child = parent.children.item(index)
    if (!child) {
      break
    }
    path.push(index)
    target = child
    if (!child.matches('blockquote, ol, ul, li, [data-callout], .markdown-annotation-block')) {
      break
    }
    parent = child
  }
  if (target) {
    setWithLRU(anchors, key, {
      path,
      tagName: target.tagName,
      offset: target.getBoundingClientRect().top - top,
      diagramCount
    })
  }
}

export function restoreMarkdownMermaidScrollAnchor(
  container: HTMLElement,
  key: string
): (() => void) | null {
  const anchor = anchors.get(key)
  const scrollTop = scrollTopCache.get(key)
  if (!anchor || scrollTop === undefined) {
    return null
  }
  cancelMermaidNavigation(container)
  container.scrollTop = scrollTop
  let frameId = 0
  let attempts = 0
  let cancelled = false
  let cancelRender: (() => void) | undefined
  const cancel = (): void => {
    cancelled = true
    window.cancelAnimationFrame(frameId)
    stopListening()
  }
  const stopListening = listenMarkdownPreviewScrollInput(container, cancel, {
    cancelEditableInput: true
  })
  registerMermaidNavigation(container, cancel)
  const tryRestore = (): void => {
    if (cancelled) {
      return
    }
    const body = container.querySelector('.ProseMirror, .markdown-body')
    // Tiptap mounts React code-block views after the document DOM is already reachable.
    if (!body || body.querySelectorAll('[data-mermaid-lazy]').length < anchor.diagramCount) {
      attempts += 1
      if (attempts < 30) {
        frameId = window.requestAnimationFrame(tryRestore)
      } else {
        cancelMermaidNavigation(container)
        container.scrollTop = scrollTop
      }
      return
    }
    let target: Element | null = body
    for (const index of anchor.path) {
      target = target.children.item(index)
      if (!target) {
        cancelMermaidNavigation(container)
        container.scrollTop = scrollTop
        return
      }
    }
    if (target.tagName !== anchor.tagName) {
      cancelMermaidNavigation(container)
      container.scrollTop = scrollTop
      return
    }
    const element = target
    const reveal = (): void => {
      if (body.contains(element)) {
        container.scrollTop +=
          element.getBoundingClientRect().top -
          container.getBoundingClientRect().top -
          anchor.offset
      }
    }
    reveal()
    cancelRender = settleMermaidNavigation(container, reveal, element)
  }
  tryRestore()
  return () => {
    cancel()
    cancelRender?.()
  }
}
