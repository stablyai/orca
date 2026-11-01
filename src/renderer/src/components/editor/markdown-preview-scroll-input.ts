import { isEditableTarget } from '@/lib/editable-target'

export function listenMarkdownPreviewScrollInput(
  container: HTMLElement,
  cancel: () => void,
  options?: { cancelEditableInput?: boolean }
): () => void {
  const cancelEditableInput = options?.cancelEditableInput === true
  const pointer = (event: PointerEvent): void => {
    if (cancelEditableInput || !isEditableTarget(event.target)) {
      cancel()
    }
  }
  const keyboard = (event: KeyboardEvent): void => {
    if (
      (cancelEditableInput || !isEditableTarget(event.target)) &&
      ['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(event.key)
    ) {
      cancel()
    }
  }
  container.addEventListener('wheel', cancel, { passive: true })
  container.addEventListener('touchmove', cancel, { passive: true })
  container.addEventListener('pointerdown', pointer)
  container.addEventListener('keydown', keyboard)
  if (cancelEditableInput) {
    container.addEventListener('beforeinput', cancel)
  }
  return () => {
    container.removeEventListener('wheel', cancel)
    container.removeEventListener('touchmove', cancel)
    container.removeEventListener('pointerdown', pointer)
    container.removeEventListener('keydown', keyboard)
    if (cancelEditableInput) {
      container.removeEventListener('beforeinput', cancel)
    }
  }
}
