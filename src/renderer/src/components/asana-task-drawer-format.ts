import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import type { AsanaTask } from '../../../shared/types'

const relativeFormatter = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' })

export function formatRelativeTime(input: string): string {
  const date = new Date(input)
  if (Number.isNaN(date.getTime())) {
    return 'recently'
  }
  const diffMinutes = Math.round((date.getTime() - Date.now()) / 60_000)
  if (Math.abs(diffMinutes) < 60) {
    return relativeFormatter.format(diffMinutes, 'minute')
  }
  const diffHours = Math.round(diffMinutes / 60)
  if (Math.abs(diffHours) < 24) {
    return relativeFormatter.format(diffHours, 'hour')
  }
  return relativeFormatter.format(Math.round(diffHours / 24), 'day')
}

// Why: Asana task gids are long numeric strings with no short human key, so the
// branch name leans on the title slug prefixed with a trailing gid fragment for
// uniqueness.
export function buildAsanaBranchName(task: AsanaTask): string {
  const slug = task.title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 52)
  const shortId = task.gid.slice(-6)
  return slug ? `asana-${shortId}-${slug}` : `asana-${shortId}`
}

export function buildAsanaPrompt(task: AsanaTask): string {
  return `Complete Asana task: ${task.title}\n\n${task.url}`
}

export async function copyTextToClipboard(text: string, label: string): Promise<void> {
  try {
    await window.api.ui.writeClipboardText(text)
    toast.success(
      translate('auto.components.AsanaIssueWorkspace.43e26f1a9b', '{{label}} copied', { label })
    )
  } catch {
    toast.error(
      translate('auto.components.AsanaIssueWorkspace.c1be5501dd', 'Failed to copy {{label}}', {
        label: label.toLowerCase()
      })
    )
  }
}
