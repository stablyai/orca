/** Share arrow navigation between checkboxes and result disclosures; keep native Space/Enter and picker disclosure Tab behavior. */
export function moveInTree(event: React.KeyboardEvent<HTMLElement>): void {
  const target = event.target
  if (!(target instanceof HTMLElement)) {
    return
  }
  const controls = [
    ...event.currentTarget.querySelectorAll<HTMLElement>(
      '[role="checkbox"]:not(:disabled), button[aria-expanded][tabindex="0"]'
    )
  ]
  const onTree = target === event.currentTarget
  if (!onTree && !controls.includes(target)) {
    return
  }
  const jump =
    event.key === 'Home' || (onTree && event.key === 'ArrowDown')
      ? controls[0]
      : event.key === 'End' || (onTree && event.key === 'ArrowUp')
        ? controls.at(-1)
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
    controls[controls.indexOf(target) + (event.key === 'ArrowDown' ? 1 : -1)]?.focus()
    return
  }
  if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
    event.preventDefault()
    // Rows are flat treeitems, so the nearest one owns this control's disclosure.
    const disclosure = target
      .closest('[role="treeitem"]')
      ?.querySelector<HTMLButtonElement>('button[aria-expanded]')
    const open = disclosure?.getAttribute('aria-expanded') === 'true'
    if (disclosure && open === (event.key === 'ArrowLeft')) {
      disclosure.click()
    }
  }
}
