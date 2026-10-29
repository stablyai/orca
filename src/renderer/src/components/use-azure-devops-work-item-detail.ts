import { useEffect, useState, type Dispatch, type SetStateAction } from 'react'
import { useAppStore } from '@/store'
import { translate } from '@/i18n/i18n'
import type { AzureDevOpsWorkItemDetail } from '../../../shared/azure-devops/boards-types'
import type { Repo } from '../../../shared/repo-types'

/** Loads the dialog's work item whenever `detailId` changes; results after a change are dropped. */
export function useAzureDevOpsWorkItemDetail(repo: Repo | null): {
  detailId: number | null
  setDetailId: Dispatch<SetStateAction<number | null>>
  detail: AzureDevOpsWorkItemDetail | null
  detailLoading: boolean
  detailError: string | null
} {
  const loadAzureDevOpsWorkItem = useAppStore((s) => s.loadAzureDevOpsWorkItem)
  const [detailId, setDetailId] = useState<number | null>(null)
  const [detail, setDetail] = useState<AzureDevOpsWorkItemDetail | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const [detailError, setDetailError] = useState<string | null>(null)

  useEffect(() => {
    if (!repo || detailId === null) {
      setDetail(null)
      setDetailError(null)
      return
    }
    let cancelled = false
    setDetailLoading(true)
    setDetail(null)
    void loadAzureDevOpsWorkItem(repo, detailId)
      .then((loaded) => {
        if (cancelled) {
          return
        }
        setDetail(loaded)
        setDetailError(
          loaded
            ? null
            : translate('auto.components.TaskPage.azureDevOps.itemMissing', 'Work item not found.')
        )
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setDetailError(error instanceof Error ? error.message : String(error))
        }
      })
      .finally(() => {
        if (!cancelled) {
          setDetailLoading(false)
        }
      })
    return () => {
      cancelled = true
    }
  }, [repo, detailId, loadAzureDevOpsWorkItem])

  return { detailId, setDetailId, detail, detailLoading, detailError }
}
