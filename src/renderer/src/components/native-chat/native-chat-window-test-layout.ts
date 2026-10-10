export function transcriptWindowHeight(root: ParentNode): number {
  const window = root.querySelector<HTMLElement>('[data-native-chat-window]')
  if (!window) {
    return 0
  }
  if (window.style.height) {
    return Number.parseFloat(window.style.height) || 0
  }
  return Array.from(window.children).reduce(
    (height, child) =>
      height +
      (child instanceof HTMLElement
        ? child.hasAttribute('data-index')
          ? child.offsetHeight
          : Number.parseFloat(child.style.height) || 0
        : 0),
    0
  )
}

export function transcriptRowOffset(row: HTMLElement): number {
  if (row.style.position === 'absolute') {
    return Number.parseFloat(row.style.top) || 0
  }
  let top = 0
  for (
    let sibling = row.previousElementSibling;
    sibling;
    sibling = sibling.previousElementSibling
  ) {
    if (sibling instanceof HTMLElement) {
      top += sibling.hasAttribute('data-index')
        ? sibling.offsetHeight
        : Number.parseFloat(sibling.style.height) || 0
    }
  }
  return top
}
