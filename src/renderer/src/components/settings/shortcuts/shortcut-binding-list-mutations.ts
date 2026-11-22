// Leave deduplication to saveBindings/normalizeKeybindingListForAction.

export function appendBinding(list: readonly string[], binding: string): string[] {
  return [...list, binding]
}

export function replaceBindingAt(
  list: readonly string[],
  index: number,
  binding: string
): string[] {
  if (index < 0 || index >= list.length) {
    return [...list]
  }
  return list.map((existing, current) => (current === index ? binding : existing))
}

export function removeBindingAt(list: readonly string[], index: number): string[] {
  if (index < 0 || index >= list.length) {
    return [...list]
  }
  return list.filter((_, current) => current !== index)
}

export function adjustRecordingIndexAfterRemove(
  current: number | null,
  removedIndex: number
): number | null {
  if (current === null) {
    return null
  }
  if (current === removedIndex) {
    return null
  }
  return current > removedIndex ? current - 1 : current
}
