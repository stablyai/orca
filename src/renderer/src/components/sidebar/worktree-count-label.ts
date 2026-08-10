import { translate } from '@/i18n/i18n'

/** Localized worktree count for sidebar visibility / import copy. */
export function formatWorktreeCountLabel(count: number): string {
  return count === 1
    ? translate('auto.components.sidebar.worktreeCount.one', '1 worktree')
    : translate('auto.components.sidebar.worktreeCount.other', '{{count}} worktrees', {
        count
      })
}
