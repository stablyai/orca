export type ContextualTourTarget = {
  element: Element
  rect: DOMRect
}

export function getMeasurableContextualTourTarget(
  selector: string,
  root?: ParentNode
): ContextualTourTarget | null {
  const queryRoot = root ?? (typeof document !== 'undefined' ? document : null)
  const elements = getContextualTourTargetCandidates(selector, queryRoot)
  for (const element of elements) {
    if (!element || typeof element.getBoundingClientRect !== 'function') {
      continue
    }
    if (!isContextualTourTargetVisible(element)) {
      continue
    }
    let rect: DOMRect
    try {
      rect = element.getBoundingClientRect()
    } catch {
      continue
    }
    if (isMeasurableRect(rect)) {
      return { element, rect }
    }
  }
  return null
}

export function hasContextualTourTarget(selector: string, root?: ParentNode): boolean {
  return getMeasurableContextualTourTarget(selector, root) !== null
}

function isMeasurableRect(rect: DOMRect): boolean {
  return (
    Number.isFinite(rect.width) && Number.isFinite(rect.height) && rect.width > 0 && rect.height > 0
  )
}

function getContextualTourTargetCandidates(
  selector: string,
  queryRoot: ParentNode | null
): Element[] {
  if (!queryRoot) {
    return []
  }
  try {
    if (typeof queryRoot.querySelectorAll === 'function') {
      return Array.from(queryRoot.querySelectorAll(selector))
    }
    return queryRoot.querySelector(selector) ? [queryRoot.querySelector(selector)!] : []
  } catch {
    return []
  }
}

function isContextualTourTargetVisible(element: Element): boolean {
  if (
    typeof element.closest === 'function' &&
    element.closest('[hidden],[inert],[aria-hidden="true"]')
  ) {
    return false
  }

  if (typeof window === 'undefined' || typeof HTMLElement === 'undefined') {
    return true
  }

  let current: Element | null = element
  while (current instanceof HTMLElement) {
    const style = window.getComputedStyle(current)
    if (
      style.display === 'none' ||
      style.visibility === 'hidden' ||
      style.visibility === 'collapse'
    ) {
      return false
    }
    current = current.parentElement
  }
  return true
}
