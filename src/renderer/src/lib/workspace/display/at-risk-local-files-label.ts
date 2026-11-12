import { translate } from '@/i18n/i18n'
import type { Translate } from '@/i18n/use-translate'
import type { WorktreeAtRiskLocalFiles } from '../../../../../shared/worktree/at-risk-local-files'

/** ".env, local/ +2", or null when the check found no names to show. */
export function formatAtRiskLocalFileNames(
  files: WorktreeAtRiskLocalFiles,
  t: Translate = translate
): string | null {
  if (files.samplePaths.length === 0) {
    return null
  }
  const names = files.samplePaths.join(', ')
  if (!files.complete) {
    return t('components.workspace.atRiskLocalFiles.namesAndMore', '{{names}} and more', { names })
  }
  const remaining = files.count - files.samplePaths.length
  return remaining > 0
    ? t('components.workspace.atRiskLocalFiles.namesWithCount', '{{names}} +{{value0}}', {
        names,
        value0: remaining
      })
    : names
}
