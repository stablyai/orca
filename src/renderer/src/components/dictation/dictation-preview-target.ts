export type DictationPreviewTarget = {
  kind: 'terminal-preview'
  insertText: (text: string) => Promise<boolean>
}

const previewTargets = new WeakMap<Element, () => DictationPreviewTarget>()

export function registerDictationPreviewTarget(
  container: HTMLElement,
  capture: () => DictationPreviewTarget
): () => void {
  previewTargets.set(container, capture)
  return () => {
    if (previewTargets.get(container) === capture) {
      previewTargets.delete(container)
    }
  }
}

export function captureDictationPreviewTarget(element: Element): DictationPreviewTarget | null {
  for (let current: Element | null = element; current; current = current.parentElement) {
    const capture = previewTargets.get(current)
    if (capture) {
      return capture()
    }
  }
  return null
}
