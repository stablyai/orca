export function getWorktreeOptionId(rowKey: string): string {
  return `worktree-list-option-${encodeURIComponent(rowKey)}`
}

export function getMountedWorktreeOptions(
  worktreeId: string,
  root?: ParentNode | null
): HTMLElement[] {
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
  const matchingIdOptions = getMountedWorktreeOptions(worktreeId, sidebar)
  const primaryOption = primaryRowKey
    ? matchingIdOptions.find((option) => option.dataset.worktreeRowKey === primaryRowKey)
    : matchingIdOptions[0]
  const primaryHostIdentity = primaryOption?.dataset.worktreeHostIdentity
  const nextOptions = primaryHostIdentity
    ? matchingIdOptions.filter(
        (option) => option.dataset.worktreeHostIdentity === primaryHostIdentity
      )
    : matchingIdOptions
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
