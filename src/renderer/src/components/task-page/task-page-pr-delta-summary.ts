import { translate } from '@/i18n/i18n'
import type { GitHubWorkItem } from '../../../../shared/github/work-item-types'

export function formatPRDelta(item: GitHubWorkItem): string | null {
  const parts: string[] = []
  if (typeof item.additions === 'number') {
    parts.push(`+${item.additions}`)
  }
  if (typeof item.deletions === 'number') {
    parts.push(`-${item.deletions}`)
  }
  if (typeof item.changedFiles === 'number') {
    parts.push(
      item.changedFiles === 1
        ? translate('auto.components.TaskPage.changedFileCount_one', '{{count}} file', {
            count: item.changedFiles
          })
        : translate('auto.components.TaskPage.changedFileCount_other', '{{count}} files', {
            count: item.changedFiles
          })
    )
  }
  return parts.length > 0 ? parts.join(' ') : null
}
