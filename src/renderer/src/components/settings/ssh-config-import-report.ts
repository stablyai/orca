import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { getSshConfigImportOutcome } from '@/lib/ssh-config-import-truncation-notice'
import type { SshConfigImportResult } from '../../../../shared/ssh-types'

/**
 * Toast the outcome of an explicit Import. A truncated import warns instead of
 * reporting success — the synced hosts are real, but they are not the whole config.
 */
export function reportSshConfigImport(result: SshConfigImportResult): void {
  const outcome = getSshConfigImportOutcome(result)
  if (outcome.kind === 'truncated') {
    toast.warning(outcome.message)
    return
  }
  if (outcome.kind === 'in-sync') {
    toast('~/.ssh/config already in sync')
    return
  }
  toast.success(
    translate('auto.components.settings.SshPane.f8050f6307', 'Synced {{value0}} server{{value1}}', {
      value0: result.targets.length,
      value1: result.targets.length > 1 ? 's' : ''
    })
  )
}

/**
 * The passive on-open sync reports nothing on success, but a partial config is not
 * a success — without this the dropped hosts look identical to hosts never configured.
 */
export function reportSshConfigSyncTruncation(result: SshConfigImportResult): void {
  const outcome = getSshConfigImportOutcome(result)
  if (outcome.kind === 'truncated') {
    toast.warning(outcome.message)
  }
}
