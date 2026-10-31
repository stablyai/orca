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
      translate('auto.components.TaskPage.changedFileCount', '{{count}} files', {
        count: item.changedFiles,
        defaultValue_one: '{{count}} file'
      })
    )
  }
  return parts.length > 0 ? parts.join(' ') : null
}
