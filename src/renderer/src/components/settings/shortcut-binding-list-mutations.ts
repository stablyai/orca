// Pure array operations for editing one action's binding list. The override
// model stores all of an action's bindings in a single array, so adding,
// editing, or removing a single binding means saving a mutated copy of the
// effective list. Kept side-effect-free (no dedupe — saveBindings/
// normalizeKeybindingListForAction already dedupe) so they stay unit-testable.

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

// Keeps a pending recording aimed at the right binding after a sibling is
// removed: the recorded row is gone (→ null), rows below it shift up by one,
// rows above are untouched.
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
