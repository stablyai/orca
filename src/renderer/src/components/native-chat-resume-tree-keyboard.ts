// Keyboard movement inside the resume dialog's tree.

/**
 * Tree keys. On a row's checkbox: Up/Down step between the enabled checkboxes, Home/End jump to the
 * first/last, Left collapses and Right expands the node through its own disclosure; Space toggles
 * natively. On the tree itself (its Tab stop): Down/Home enter at the first checkbox, Up/End at
 * the last.
 */
export function moveInResumeTree(event: React.KeyboardEvent<HTMLElement>): void {
  const target = event.target
  if (!(target instanceof HTMLElement)) {
    return
  }
  const boxes = [
    ...event.currentTarget.querySelectorAll<HTMLElement>('[role="checkbox"]:not(:disabled)')
  ]
  const onTree = target === event.currentTarget
  if (!onTree && target.getAttribute('role') !== 'checkbox') {
    return
  }
  const jump =
    event.key === 'Home' || (onTree && event.key === 'ArrowDown')
      ? boxes[0]
      : event.key === 'End' || (onTree && event.key === 'ArrowUp')
        ? boxes.at(-1)
        : undefined
  if (jump) {
    event.preventDefault()
    jump.focus()
    return
  }
  if (onTree) {
    return
  }
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault()
    boxes[boxes.indexOf(target) + (event.key === 'ArrowDown' ? 1 : -1)]?.focus()
    return
  }
  if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
    event.preventDefault()
    // Rows are flat treeitems, so the nearest one is this checkbox's own node.
    const disclosure = target
      .closest('[role="treeitem"]')
      ?.querySelector<HTMLButtonElement>('button[aria-expanded]')
    const open = disclosure?.getAttribute('aria-expanded') === 'true'
    if (disclosure && open === (event.key === 'ArrowLeft')) {
      disclosure.click()
    }
  }
}
