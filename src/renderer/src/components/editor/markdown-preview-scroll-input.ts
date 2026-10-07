import { isEditableTarget } from '@/lib/editable-target'

export function listenMarkdownPreviewScrollInput(
  container: HTMLDivElement,
  cancel: () => void
): () => void {
  const pointer = (event: PointerEvent): void => {
    if (!isEditableTarget(event.target)) {
      cancel()
    }
  }
  const keyboard = (event: KeyboardEvent): void => {
    if (
      !isEditableTarget(event.target) &&
      ['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(event.key)
    ) {
      cancel()
    }
  }
  container.addEventListener('wheel', cancel, { passive: true })
  container.addEventListener('touchmove', cancel, { passive: true })
  container.addEventListener('pointerdown', pointer)
  container.addEventListener('keydown', keyboard)
  return () => {
    container.removeEventListener('wheel', cancel)
    container.removeEventListener('touchmove', cancel)
    container.removeEventListener('pointerdown', pointer)
    container.removeEventListener('keydown', keyboard)
  }
}
