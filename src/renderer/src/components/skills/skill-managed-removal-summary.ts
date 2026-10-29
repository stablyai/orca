import type { SkillInstallResult } from '../../../../shared/skill-install-contract'
import type { SkillRemoveOperation } from '../../../../shared/skill-sharing-contract'
import { translate } from '@/i18n/i18n'

function managedRemovalNotice(removed: number, preserved: number): string {
  if (preserved === 0) {
    return translate('auto.components.skills.managedRemoval.removed', '{{removed}} removed.', {
      removed
    })
  }
  return preserved === 1
    ? translate(
        'auto.components.skills.managedRemoval.removedPreserved_one',
        '{{removed}} removed · {{count}} modified skill preserved.',
        { removed, count: preserved }
      )
    : translate(
        'auto.components.skills.managedRemoval.removedPreserved_other',
        '{{removed}} removed · {{count}} modified skills preserved.',
        { removed, count: preserved }
      )
}

export function summarizeManagedSkillRemoval(
  operations: readonly SkillRemoveOperation[],
  installCount: number
): {
  lastResult: SkillInstallResult | null
  notice: string | null
  removed: number
  complete: boolean
} {
  const values = operations.flatMap((operation) =>
    operation.status === 'ok' ? [operation.value] : []
  )
  const removed = values.filter((value) => value.status === 'removed').length
  const preserved = values.filter((value) => value.status === 'conflict').length
  return {
    lastResult: values.at(-1) ?? null,
    notice: installCount > 1 ? managedRemovalNotice(removed, preserved) : null,
    removed,
    complete: preserved === 0 && values.every((value) => value.status !== 'failed')
  }
}
