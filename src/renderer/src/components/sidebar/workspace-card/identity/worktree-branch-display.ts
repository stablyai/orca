import 'react'

import '@/i18n/i18n'
import '../activity/worktree-card-empty-inputs'

export function branchDisplayName(branch: string): string {
  return branch.replace(/^refs\/heads\//, '')
}
