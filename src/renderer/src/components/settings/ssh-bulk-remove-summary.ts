import { translate } from '@/i18n/i18n'
import type { SshBulkRemovePlan } from './ssh-target-list-model'

export type SshBulkRemoveSummary = {
  tone: 'success' | 'neutral' | 'error'
  title: string
  description?: string
}

/** One toast for a whole bulk removal: counts first, then each host that needs a separate step. */
export function summarizeSshBulkRemove(args: {
  removedCount: number
  skipped: SshBulkRemovePlan['skipped']
  failed: { label: string; message: string }[]
}): SshBulkRemoveSummary {
  const parts: string[] = []
  if (args.removedCount > 0) {
    parts.push(
      translate('auto.components.settings.sshBulkRemove.removedCount', '{{count}} removed', {
        count: args.removedCount
      })
    )
  }
  if (args.skipped.length > 0) {
    parts.push(
      translate('auto.components.settings.sshBulkRemove.skippedCount', '{{count}} skipped', {
        count: args.skipped.length
      })
    )
  }
  if (args.failed.length > 0) {
    parts.push(
      translate('auto.components.settings.sshBulkRemove.failedCount', '{{count}} failed', {
        count: args.failed.length
      })
    )
  }
  const lines = [
    ...args.skipped.map(({ target, reason }) =>
      reason === 'managed-server'
        ? translate(
            'auto.components.settings.sshBulkRemove.skippedManaged',
            '{{label}} has an Orca server.',
            { label: target.label }
          )
        : translate(
            'auto.components.settings.sshBulkRemove.skippedWorkspaces',
            '{{label}} has workspaces.',
            { label: target.label }
          )
    ),
    ...args.failed.map(({ label, message }) => `${label}: ${message}`)
  ]
  if (args.skipped.length > 0) {
    lines.push(
      translate(
        'auto.components.settings.sshBulkRemove.skippedHint',
        'Remove skipped hosts one at a time to choose what happens to them.'
      )
    )
  }
  const tone =
    args.removedCount === 0 && args.failed.length > 0
      ? 'error'
      : args.failed.length > 0 || args.skipped.length > 0
        ? 'neutral'
        : 'success'
  return {
    tone,
    title: parts.join(' · '),
    ...(lines.length > 0 ? { description: lines.join(' ') } : {})
  }
}
