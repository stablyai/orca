import { revealElementInScrollContainer } from './worktree-sidebar-reveal'

export function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) {
    return false
  }

  // xterm's hidden input textarea isn't a real text field; treating it as one would block sidebar shortcuts.
  if (target.classList.contains('xterm-helper-textarea')) {
    return false
  }

  if (target.isContentEditable) {
    return true
  }

  return (
    target.closest('input, textarea, select, [contenteditable=""], [contenteditable="true"]') !==
    null
  )
}

export function getWorktreeOptionId(rowKey: string): string {
  return `worktree-list-option-${encodeURIComponent(rowKey)}`
}

function getMountedWorktreeOptions(worktreeId: string, root?: ParentNode | null): HTMLElement[] {
  const scope = root ?? document
  const result: HTMLElement[] = []
  scope.querySelectorAll<HTMLElement>('[data-worktree-id]').forEach((element) => {
    if (element.dataset.worktreeId === worktreeId) {
      result.push(element)
    }
  })
  return result
}

export function markSidebarWorktreeActiveImmediately(
  worktreeId: string,
  primaryRowKey?: string
): void {
  const sidebar = document.querySelector<HTMLElement>('[data-worktree-sidebar]')
  const nextOptions = getMountedWorktreeOptions(worktreeId, sidebar)
  const nextOption = nextOptions[0]
  if (!nextOption) {
    return
  }

  sidebar
    ?.querySelectorAll<HTMLElement>('[role="option"][aria-current="page"]')
    .forEach((option) => option.removeAttribute('aria-current'))

  for (const option of nextOptions) {
    option.setAttribute('aria-current', 'page')
  }
  sidebar
    ?.querySelectorAll<HTMLElement>('[data-worktree-card-surface][data-worktree-card-active]')
    .forEach((surface) => {
      if (!nextOptions.some((option) => option.contains(surface))) {
        surface.removeAttribute('data-worktree-card-active')
      }
    })
  for (const option of nextOptions) {
    const activeSurfaceVariant =
      primaryRowKey !== undefined
        ? option.dataset.worktreeRowKey === primaryRowKey
          ? 'primary'
          : 'secondary'
        : option === nextOption
          ? 'primary'
          : 'secondary'
    const surface = option.matches('[data-worktree-card-surface]')
      ? option
      : option.querySelector<HTMLElement>('[data-worktree-card-surface]')
    surface?.setAttribute('data-worktree-card-active', activeSurfaceVariant)
  }
}

export function revealMountedWorktreeElement(
  container: HTMLElement,
  worktreeId: string,
  behavior: ScrollBehavior,
  optionId?: string,
  onScrollIssued?: (targetTop: number) => void
): HTMLElement | null {
  const element = optionId
    ? document.getElementById(optionId)
    : getMountedWorktreeOptions(worktreeId, container)[0]
  if (!element || !container.contains(element)) {
    return null
  }
  return revealElementInScrollContainer(container, element, behavior, onScrollIssued)
    ? element
    : null
}

export function revealMountedSidebarRowElement(
  container: HTMLElement,
  rowKey: string,
  behavior: ScrollBehavior,
  onScrollIssued?: (targetTop: number) => void
): HTMLElement | null {
  const element = document.getElementById(getWorktreeOptionId(rowKey))
  if (!element || !container.contains(element)) {
    return null
  }
  return revealElementInScrollContainer(container, element, behavior, onScrollIssued)
    ? element
    : null
}
