import { useEditorRevealFlashKey } from './editor-reveal-flash'

export function EditorRevealFlash({
  viewStateId
}: {
  viewStateId: string
}): React.JSX.Element | null {
  const flashKey = useEditorRevealFlashKey(viewStateId)
  // Keyed so a repeat flash remounts and restarts the animation.
  return flashKey === null ? null : (
    <span key={flashKey} className="editor-reveal-flash" aria-hidden />
  )
}
