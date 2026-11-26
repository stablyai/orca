import { useMemo } from 'react'
import { toast } from 'sonner'
import { useAppStore } from '@/store'
import { useTranslate } from '@/i18n/use-translate'
import type { Repo } from '../../../../../../shared/repository/repo-types'
import { planBulkRepoAppearanceUpdates } from '../../../../../../shared/repository/appearance/bulk-repo-appearance'

export function useBulkRepoAppearance(repo: Repo): {
  canApplyToAll: boolean
  applyToAll: () => void
} {
  const t = useTranslate()
  const repos = useAppStore((state) => state.repos)
  const storeUpdateRepo = useAppStore((state) => state.updateRepo)
  const plan = useMemo(() => planBulkRepoAppearanceUpdates(repo, repos), [repo, repos])

  const applyToAll = (): void => {
    if (plan.length === 0) {
      return
    }
    for (const entry of plan) {
      void storeUpdateRepo(entry.repoId, entry.updates, { hostId: entry.hostId })
    }
    toast(
      t('auto.components.repo.ProjectPeek.appliedToAll', 'Applied to {{count}} projects', {
        count: plan.length,
        defaultValue_one: 'Applied to {{count}} project'
      }),
      {
        action: {
          label: t('auto.components.repo.ProjectPeek.undo', 'Undo'),
          onClick: () => {
            for (const entry of plan) {
              void storeUpdateRepo(entry.repoId, entry.previous, { hostId: entry.hostId })
            }
          }
        }
      }
    )
  }

  return { canApplyToAll: plan.length > 0, applyToAll }
}
