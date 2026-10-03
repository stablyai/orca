import { formatShortcutLabel } from '@/hooks/useShortcutLabel'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'

export function createContextualCopyHintNode(): HTMLButtonElement {
  const copyHintNode = document.createElement('button')
  copyHintNode.type = 'button'
  copyHintNode.tabIndex = -1
  copyHintNode.className =
    'cursor-pointer rounded-md border border-border/90 bg-background px-2.5 py-1 text-xs font-medium text-foreground shadow-[0_6px_18px_rgba(15,23,42,0.18)] backdrop-blur whitespace-nowrap hover:bg-accent hover:text-accent-foreground'
  copyHintNode.style.display = 'none'
  refreshContextualCopyHintLabel(copyHintNode)
  return copyHintNode
}

export function refreshContextualCopyHintLabel(copyHintNode: HTMLButtonElement): void {
  const copyContextLabel = translate(
    'auto.components.editor.setupContextualCopy.copyContext',
    'Copy context'
  )
  copyHintNode.textContent = `${copyContextLabel} ${formatShortcutLabel(
    'editor.copyContext',
    useAppStore.getState().keybindings
  )}`
  copyHintNode.setAttribute('aria-label', copyContextLabel)
}

export function attachContextualCopyHintPointerDown(
  copyHintNode: HTMLButtonElement,
  onCopy: () => void
): () => void {
  // Why: pointerdown runs before Monaco steals focus / hides this widget on
  // blur. preventDefault keeps the editor selection intact while we copy.
  const handlePointerDown = (event: PointerEvent): void => {
    if (event.button !== 0) {
      return
    }
    event.preventDefault()
    event.stopPropagation()
    onCopy()
  }
  copyHintNode.addEventListener('pointerdown', handlePointerDown)
  return () => copyHintNode.removeEventListener('pointerdown', handlePointerDown)
}
