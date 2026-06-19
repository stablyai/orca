export function installDiffCommentZoneMouseDownStopper(target: EventTarget): () => void {
  const stopMouseDownPropagation = (ev: Event): void => ev.stopPropagation()
  target.addEventListener('mousedown', stopMouseDownPropagation)
  return () => target.removeEventListener('mousedown', stopMouseDownPropagation)
}
