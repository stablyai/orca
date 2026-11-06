export function isEventTargetInsideCurrentTarget(
  currentTarget: EventTarget | null,
  target: EventTarget | null
): boolean {
  if (!(currentTarget instanceof Node) || !(target instanceof Node)) {
    return false
  }
  return currentTarget.contains(target)
}
