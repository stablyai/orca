export type MouseShortcutInput = {
  key: 'MouseBack' | 'MouseForward'
  altKey: boolean
  ctrlKey: boolean
  metaKey: boolean
  shiftKey: boolean
}

export function parseMouseShortcutInput(value: unknown): MouseShortcutInput | null {
  if (
    !value ||
    typeof value !== 'object' ||
    !('key' in value) ||
    (value.key !== 'MouseBack' && value.key !== 'MouseForward') ||
    !('altKey' in value) ||
    typeof value.altKey !== 'boolean' ||
    !('ctrlKey' in value) ||
    typeof value.ctrlKey !== 'boolean' ||
    !('metaKey' in value) ||
    typeof value.metaKey !== 'boolean' ||
    !('shiftKey' in value) ||
    typeof value.shiftKey !== 'boolean'
  ) {
    return null
  }
  return {
    key: value.key,
    altKey: value.altKey,
    ctrlKey: value.ctrlKey,
    metaKey: value.metaKey,
    shiftKey: value.shiftKey
  }
}
