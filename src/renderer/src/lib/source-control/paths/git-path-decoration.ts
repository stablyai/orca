import type { GitFileStatus } from '../../../../../shared/git/status/git-status-types'

export const STATUS_COLORS: Record<GitFileStatus, string> = {
  modified: 'var(--git-decoration-modified)',
  added: 'var(--git-decoration-added)',
  deleted: 'var(--git-decoration-deleted)',
  renamed: 'var(--git-decoration-renamed)',
  untracked: 'var(--git-decoration-untracked)',
  copied: 'var(--git-decoration-copied)'
}
