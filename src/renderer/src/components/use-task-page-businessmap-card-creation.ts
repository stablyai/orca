import type { TaskPageJiraIssueCreationModel } from './use-task-page-jira-issue-creation'
import { useCallback } from 'react'
import { businessmapCreateCard, businessmapGetCard } from '@/runtime/runtime-businessmap-client'
import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'

export function useTaskPageBusinessmapCardCreation(model: TaskPageJiraIssueCreationModel) {
  const {
    settings,
    providerRuntimeContextKey,
    providerRuntimeContextKeyRef,
    businessmapTaskSourceContext,
    setSelectedBusinessmapCard,
    setBusinessmapCards,
    setBusinessmapRefreshNonce,
    setNewBusinessmapCardOpen,
    newBusinessmapCardTitle,
    setNewBusinessmapCardTitle,
    newBusinessmapCardBody,
    setNewBusinessmapCardBody,
    newBusinessmapCardSubmitting,
    setNewBusinessmapCardSubmitting,
    newBusinessmapCardBoardId,
    discardNewBusinessmapCardDraft
  } = model
  const handleCreateNewBusinessmapCard = useCallback(async (): Promise<void> => {
    if (newBusinessmapCardBoardId === null) {
      return
    }
    const title = newBusinessmapCardTitle.trim()
    if (!title || newBusinessmapCardSubmitting) {
      return
    }
    setNewBusinessmapCardSubmitting(true)
    const submitProviderRuntimeContextKey = providerRuntimeContextKey
    try {
      const result = await businessmapCreateCard(businessmapTaskSourceContext ?? settings, {
        boardId: newBusinessmapCardBoardId,
        title,
        description: newBusinessmapCardBody || undefined
      })
      if (submitProviderRuntimeContextKey !== providerRuntimeContextKeyRef.current) {
        return
      }
      if (!result.ok) {
        toast.error(
          result.error ||
            translate('auto.components.TaskPage.businessmapCreateFailed', 'Failed to create card.')
        )
        return
      }
      toast.success(
        translate('auto.components.TaskPage.cb98f0350c', 'Created {{value0}}', {
          value0: `#${result.id}`
        }),
        {
          action: result.url
            ? {
                label: translate('auto.components.TaskPage.9c57663908', 'View'),
                onClick: () => window.open(result.url, '_blank')
              }
            : undefined
        }
      )
      discardNewBusinessmapCardDraft()
      setNewBusinessmapCardOpen(false)
      setNewBusinessmapCardTitle('')
      setNewBusinessmapCardBody('')
      setBusinessmapRefreshNonce((n) => n + 1)
      void businessmapGetCard(businessmapTaskSourceContext ?? settings, result.id)
        .then((full) => {
          if (submitProviderRuntimeContextKey !== providerRuntimeContextKeyRef.current) {
            return
          }
          if (full) {
            setBusinessmapCards((prev) => [full, ...prev.filter((card) => card.id !== full.id)])
            setSelectedBusinessmapCard(full)
          }
        })
        .catch(() => {})
    } catch (error) {
      if (submitProviderRuntimeContextKey === providerRuntimeContextKeyRef.current) {
        toast.error(
          error instanceof Error
            ? error.message
            : translate(
                'auto.components.TaskPage.businessmapCreateFailed',
                'Failed to create card.'
              )
        )
      }
    } finally {
      if (submitProviderRuntimeContextKey === providerRuntimeContextKeyRef.current) {
        setNewBusinessmapCardSubmitting(false)
      }
    }
  }, [
    businessmapTaskSourceContext,
    discardNewBusinessmapCardDraft,
    newBusinessmapCardBody,
    newBusinessmapCardBoardId,
    newBusinessmapCardSubmitting,
    newBusinessmapCardTitle,
    providerRuntimeContextKey,
    providerRuntimeContextKeyRef,
    setBusinessmapCards,
    setBusinessmapRefreshNonce,
    setNewBusinessmapCardBody,
    setNewBusinessmapCardOpen,
    setNewBusinessmapCardSubmitting,
    setNewBusinessmapCardTitle,
    setSelectedBusinessmapCard,
    settings
  ])
  const nextModel = model as typeof model & {
    handleCreateNewBusinessmapCard: typeof handleCreateNewBusinessmapCard
  }
  nextModel.handleCreateNewBusinessmapCard = handleCreateNewBusinessmapCard
  return nextModel
}

export type TaskPageBusinessmapCardCreationModel = ReturnType<
  typeof useTaskPageBusinessmapCardCreation
>
