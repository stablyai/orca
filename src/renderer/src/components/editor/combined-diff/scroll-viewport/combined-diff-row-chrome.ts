import type { DiffViewportItem } from './combined-diff-viewport-item'

export function observeCombinedDiffRowChrome(
  item: DiffViewportItem,
  wrapper: Element | null,
  isCurrent: () => boolean = () => true
): () => void {
  let active = true
  let chrome: DiffViewportItem['chrome'] | null = null
  const heights = new Map<HTMLElement, number>()
  const resize = new ResizeObserver(() => {
    if (!active || !isCurrent()) {
      return
    }
    let changed = false
    for (const [node, height] of heights) {
      const next = node.offsetHeight
      if (next !== height) {
        heights.set(node, next)
        changed = true
      }
    }
    if (changed) {
      item.owner.invalidate(item)
    }
  })
  const refresh = (): void => {
    if (!active || !isCurrent()) {
      return
    }
    const next: DiffViewportItem['chrome'] = { header: null, conflict: null, body: null }
    for (const child of wrapper?.children ?? []) {
      if (!(child instanceof HTMLElement)) {
        continue
      }
      if (child.hasAttribute('data-combined-diff-section-header')) {
        next.header = child
      } else if (child.hasAttribute('data-combined-diff-conflict')) {
        next.conflict = child
      } else if (child.hasAttribute('data-combined-diff-body')) {
        next.body = child
      }
    }
    if (
      chrome &&
      next.header === chrome.header &&
      next.conflict === chrome.conflict &&
      next.body === chrome.body
    ) {
      return
    }
    resize.disconnect()
    heights.clear()
    for (const node of [next.header, next.conflict]) {
      if (node) {
        heights.set(node, node.offsetHeight)
        resize.observe(node)
      }
    }
    chrome = next
    item.chrome = next
    item.owner.invalidate(item)
  }
  refresh()
  const mutation = new MutationObserver(refresh)
  if (wrapper) {
    mutation.observe(wrapper, { childList: true })
  }
  return () => {
    active = false
    resize.disconnect()
    mutation.disconnect()
    heights.clear()
    if (item.chrome === chrome) {
      item.chrome = { header: null, conflict: null, body: null }
    }
  }
}

export function observeCombinedDiffRowContent(
  item: DiffViewportItem,
  row: HTMLElement
): () => void {
  let active = true
  let content: Element | null = null
  let releaseContent = (): void => {}
  const refresh = (): void => {
    if (!active || row.firstElementChild === content) {
      return
    }
    releaseContent()
    content = row.firstElementChild
    if (!content) {
      releaseContent = () => {}
      return
    }
    const current = content
    let bound = true
    const isCurrent = (): boolean => active && bound && row.firstElementChild === current
    const stopChrome = observeCombinedDiffRowChrome(item, current, isCurrent)
    const measure = (): void => {
      if (
        isCurrent() &&
        !item.binding &&
        item.bodyKind !== 'native' &&
        current instanceof HTMLElement &&
        current.offsetHeight > 0
      ) {
        item.owner.measure(item, current.offsetHeight)
      }
    }
    const resize = new ResizeObserver(measure)
    resize.observe(current)
    measure()
    releaseContent = () => {
      bound = false
      resize.disconnect()
      stopChrome()
    }
  }
  refresh()
  const mutation = new MutationObserver(refresh)
  mutation.observe(row, { childList: true })
  return () => {
    active = false
    mutation.disconnect()
    releaseContent()
  }
}
