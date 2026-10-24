export function isEventTargetInsideCurrentTarget(
  currentTarget: EventTarget | null,
  target: EventTarget | null
): currentTarget is Node {
  if (!(currentTarget instanceof Node) || !(target instanceof Node)) {
    return false
  }
  return currentTarget.contains(target)
}
