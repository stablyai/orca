import { useCallback } from 'react'
import { toast } from 'sonner'
import { useAppStore } from '@/store'
import type {
  GitHubIssueType,
  GitHubProjectFieldMutationValue,
  GitHubProjectRow
} from '../../../../shared/github/project-types'

export function useProjectRowMutations(currentCacheKey: string | null) {
  const patchProjectIssueOrPr = useAppStore((state) => state.patchProjectIssueOrPr)
  const patchProjectRowIssueType = useAppStore((state) => state.patchProjectRowIssueType)
  const updateProjectFieldValue = useAppStore((state) => state.updateProjectFieldValue)
  const clearProjectFieldValue = useAppStore((state) => state.clearProjectFieldValue)
  const editAssignees = useCallback(
    async (row: GitHubProjectRow, add: string[], remove: string[]) => {
      if (!currentCacheKey) {
        return
      }
      const result = await patchProjectIssueOrPr(currentCacheKey, row.id, {
        ...(add.length ? { addAssignees: add } : {}),
        ...(remove.length ? { removeAssignees: remove } : {})
      })
      if (!result.ok) {
        toast.error(result.error.message)
      }
    },
    [currentCacheKey, patchProjectIssueOrPr]
  )
  const editLabels = useCallback(
    async (row: GitHubProjectRow, add: string[], remove: string[]) => {
      if (!currentCacheKey) {
        return
      }
      const result = await patchProjectIssueOrPr(currentCacheKey, row.id, {
        ...(add.length ? { addLabels: add } : {}),
        ...(remove.length ? { removeLabels: remove } : {})
      })
      if (!result.ok) {
        toast.error(result.error.message)
      }
    },
    [currentCacheKey, patchProjectIssueOrPr]
  )
  const editIssueType = useCallback(
    async (row: GitHubProjectRow, issueType: GitHubIssueType | null) => {
      if (!currentCacheKey) {
        return
      }
      const result = await patchProjectRowIssueType(currentCacheKey, row.id, issueType)
      if (!result.ok) {
        toast.error(result.error.message)
      }
    },
    [currentCacheKey, patchProjectRowIssueType]
  )
  const editField = useCallback(
    async (
      row: GitHubProjectRow,
      fieldId: string,
      value: GitHubProjectFieldMutationValue | null
    ) => {
      if (!currentCacheKey) {
        return
      }
      const result = value
        ? await updateProjectFieldValue(currentCacheKey, row.id, fieldId, value)
        : await clearProjectFieldValue(currentCacheKey, row.id, fieldId)
      if (!result.ok) {
        toast.error(result.error.message)
      }
    },
    [clearProjectFieldValue, currentCacheKey, updateProjectFieldValue]
  )
  return { editAssignees, editLabels, editIssueType, editField }
}
