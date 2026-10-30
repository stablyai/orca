import { useEffect, useEffectEvent } from 'react'
import { isEditorAnchorVisible, observeAnchorAncestorVisibility } from './editor-anchor-visibility'

// Portaled editor overlays outlive a hidden editor (inactive tab or workspace), so close them instead.
export function useDismissWhenEditorHidden(
  editorRoot: HTMLElement | null,
  onDismiss: () => void
): void {
  const dismiss = useEffectEvent(onDismiss)

  useEffect(() => {
    if (!editorRoot) {
      return
    }
    const dismissIfHidden = (): void => {
      if (!isEditorAnchorVisible(editorRoot)) {
        dismiss()
      }
    }
    const mutationObserver = new MutationObserver(dismissIfHidden)
    observeAnchorAncestorVisibility(mutationObserver, editorRoot)
    const intersectionObserver =
      typeof IntersectionObserver === 'undefined'
        ? null
        : new IntersectionObserver(([entry]) => {
            if (entry && !entry.isIntersecting) {
              dismissIfHidden()
            }
          })
    intersectionObserver?.observe(editorRoot)
    return () => {
      mutationObserver.disconnect()
      intersectionObserver?.disconnect()
    }
  }, [editorRoot])
}
