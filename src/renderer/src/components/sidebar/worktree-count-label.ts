import { translate } from '@/i18n/i18n'

/** Localized worktree count for sidebar visibility / import copy. */
export function formatWorktreeCountLabel(count: number): string {
  return count === 1
    ? translate('auto.components.sidebar.worktree.count.label.50b2484c91', '1 worktree')
    : translate('auto.components.sidebar.worktree.count.label.5c8151ceba', '{{count}} worktrees', {
        count
      })
}
