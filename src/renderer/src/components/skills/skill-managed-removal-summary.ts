import type { SkillInstallResult } from '../../../../shared/skill-install-contract'
import type { SkillRemoveOperation } from '../../../../shared/skill-sharing-contract'

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
    notice:
      installCount > 1
        ? `${removed} removed${preserved ? ` · ${preserved} modified skill${preserved === 1 ? '' : 's'} preserved` : ''}.`
        : null,
    removed,
    complete: preserved === 0 && values.every((value) => value.status !== 'failed')
  }
}
