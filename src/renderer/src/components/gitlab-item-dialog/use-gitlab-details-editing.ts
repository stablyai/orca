import { useCallback } from 'react'
import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import type { GitLabMRUpdate, GitLabWorkItem } from '../../../../shared/gitlab-types'
import {
  formatGitLabLabelDraft,
  normalizeGitLabLabels,
  parseGitLabLabelDraft,
  showGitLabMutationError
} from '../gitlab-item-dialog-parts'
import type { GitLabDialogRepoSelector } from './gitlab-item-dialog-types'
import type { GitLabItemDialogState } from './use-gitlab-item-dialog-state'

export function useGitLabDetailsEditing(
  item: GitLabWorkItem | null,
  repoSelector: GitLabDialogRepoSelector | null,
  state: GitLabItemDialogState
) {
  const {
    bodyDraft,
    details,
    labelDraft,
    labelOptions,
    labelOptionsLoading,
    mountedRef,
    setBodyDraft,
    setDetails,
    setDetailsSaving,
    setEditingDetails,
    setLabelDraft,
    setLabelOptions,
    setLabelOptionsLoading,
    setTitleDraft,
    titleDraft
  } = state
  const loadGitLabLabelOptions = useCallback(async (): Promise<void> => {
    if (!repoSelector || labelOptions !== null || labelOptionsLoading) {
      return
    }
    setLabelOptionsLoading(true)
    try {
      const labels = await window.api.gl.listLabels(repoSelector)
      if (mountedRef.current) {
        setLabelOptions(normalizeGitLabLabels(labels))
      }
    } catch {
      if (mountedRef.current) {
        setLabelOptions([])
      }
    } finally {
      if (mountedRef.current) {
        setLabelOptionsLoading(false)
      }
    }
  }, [
    labelOptions,
    labelOptionsLoading,
    mountedRef,
    repoSelector,
    setLabelOptions,
    setLabelOptionsLoading
  ])

  const handleStartDetailsEdit = useCallback((): void => {
    if (!item || !details || item.type !== 'mr') {
      return
    }
    setTitleDraft(details.item.title || item.title)
    setBodyDraft(details.body)
    setLabelDraft(formatGitLabLabelDraft(details.item.labels ?? item.labels))
    setEditingDetails(true)
    void loadGitLabLabelOptions()
  }, [
    details,
    item,
    loadGitLabLabelOptions,
    setBodyDraft,
    setEditingDetails,
    setLabelDraft,
    setTitleDraft
  ])

  const handleCancelDetailsEdit = useCallback((): void => {
    setEditingDetails(false)
    setTitleDraft('')
    setBodyDraft('')
    setLabelDraft('')
  }, [setBodyDraft, setEditingDetails, setLabelDraft, setTitleDraft])

  const handleSaveDetails = useCallback(async (): Promise<void> => {
    if (!item || !details || !repoSelector || item.type !== 'mr') {
      return
    }
    const currentTitle = details.item.title || item.title
    const currentBody = details.body
    const currentLabels = normalizeGitLabLabels(details.item.labels ?? item.labels)
    const nextTitle = titleDraft.trim()
    const nextBody = bodyDraft
    const nextLabels = parseGitLabLabelDraft(labelDraft)
    if (!nextTitle) {
      toast.error(translate('auto.components.GitLabItemDialog.98718490e4', 'MR title is required.'))
      return
    }

    const currentLabelKeys = new Set(currentLabels.map((label) => label.toLowerCase()))
    const nextLabelKeys = new Set(nextLabels.map((label) => label.toLowerCase()))
    const addLabels = nextLabels.filter((label) => !currentLabelKeys.has(label.toLowerCase()))
    const removeLabels = currentLabels.filter((label) => !nextLabelKeys.has(label.toLowerCase()))
    const updates: GitLabMRUpdate = {}
    if (nextTitle !== currentTitle) {
      updates.title = nextTitle
    }
    if (nextBody !== currentBody) {
      updates.body = nextBody
    }
    if (addLabels.length > 0) {
      updates.addLabels = addLabels
    }
    if (removeLabels.length > 0) {
      updates.removeLabels = removeLabels
    }
    if (Object.keys(updates).length === 0) {
      handleCancelDetailsEdit()
      return
    }

    setDetailsSaving(true)
    try {
      const res = await window.api.gl.updateMR({ ...repoSelector, iid: item.number, updates })
      if (res.ok) {
        if (mountedRef.current) {
          setDetails((current) =>
            current
              ? {
                  ...current,
                  body: nextBody,
                  item: { ...current.item, title: nextTitle, labels: nextLabels }
                }
              : current
          )
          setLabelOptions((current) =>
            current ? normalizeGitLabLabels([...current, ...nextLabels]) : current
          )
          setEditingDetails(false)
          setTitleDraft('')
          setBodyDraft('')
          setLabelDraft('')
          useAppStore.getState().recordFeatureInteraction('gitlab-tasks')
        }
      } else if (mountedRef.current) {
        toast.error(res.error)
      }
    } catch (error) {
      if (mountedRef.current) {
        showGitLabMutationError(error)
      }
    } finally {
      if (mountedRef.current) {
        setDetailsSaving(false)
      }
    }
  }, [
    bodyDraft,
    details,
    handleCancelDetailsEdit,
    item,
    labelDraft,
    mountedRef,
    repoSelector,
    setBodyDraft,
    setDetails,
    setDetailsSaving,
    setEditingDetails,
    setLabelDraft,
    setLabelOptions,
    setTitleDraft,
    titleDraft
  ])

  return {
    handleCancelDetailsEdit,
    handleSaveDetails,
    handleStartDetailsEdit,
    loadGitLabLabelOptions
  }
}

export type GitLabDetailsEditing = ReturnType<typeof useGitLabDetailsEditing>
