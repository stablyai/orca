import { useCallback, useEffect, useRef, useState } from 'react'
import { isWebClientLocation } from '@/lib/web-client-location'
import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import type { TaskPageJiraIssueCreationModel } from './use-task-page-jira-issue-creation'

type SummaryGenerationModel = Pick<
  TaskPageJiraIssueCreationModel,
  | 'newJiraIssueOpen'
  | 'newJiraIssueTitle'
  | 'newJiraIssueBody'
  | 'newJiraIssueSubmitting'
  | 'newJiraIssueTargetProject'
  | 'newJiraIssueTargetType'
  | 'providerRuntimeContextKey'
  | 'setNewJiraIssueTitle'
>

export function useTaskPageJiraSummaryGeneration<T extends SummaryGenerationModel>(model: T) {
  const {
    newJiraIssueOpen,
    newJiraIssueTitle,
    newJiraIssueBody,
    newJiraIssueSubmitting,
    newJiraIssueTargetProject,
    newJiraIssueTargetType,
    setNewJiraIssueTitle,
    providerRuntimeContextKey
  } = model
  const newJiraIssueSummaryAvailable = !isWebClientLocation()
  const [newJiraIssueSummaryGenerating, setNewJiraIssueSummaryGenerating] = useState(false)
  const generationNonceRef = useRef(0)
  const generatingRef = useRef(false)

  const handleCancelNewJiraIssueSummaryGeneration = useCallback((): void => {
    if (!generatingRef.current) {
      return
    }
    generationNonceRef.current += 1
    generatingRef.current = false
    setNewJiraIssueSummaryGenerating(false)
    void window.api.jira.cancelGenerateIssueSummary().catch(() => {})
  }, [])

  // Changing or abandoning a draft invalidates the external generation, including on unmount.
  useEffect(
    () => () => {
      if (!generatingRef.current) {
        return
      }
      const canceledNonce = ++generationNonceRef.current
      generatingRef.current = false
      void window.api.jira
        .cancelGenerateIssueSummary()
        .catch(() => {})
        .finally(() => {
          if (generationNonceRef.current === canceledNonce) {
            setNewJiraIssueSummaryGenerating(false)
          }
        })
    },
    [
      newJiraIssueOpen,
      newJiraIssueBody,
      newJiraIssueTargetProject?.siteId,
      newJiraIssueTargetProject?.id,
      newJiraIssueTargetType?.id,
      providerRuntimeContextKey
    ]
  )

  const handleGenerateNewJiraIssueSummary = useCallback(async (): Promise<void> => {
    const description = newJiraIssueBody.trim()
    if (
      !newJiraIssueSummaryAvailable ||
      !newJiraIssueOpen ||
      !description ||
      generatingRef.current ||
      newJiraIssueSubmitting
    ) {
      return
    }
    const nonce = ++generationNonceRef.current
    const titleAtStart = newJiraIssueTitle
    generatingRef.current = true
    setNewJiraIssueSummaryGenerating(true)
    try {
      const result = await window.api.jira.generateIssueSummary({
        description,
        projectName: newJiraIssueTargetProject?.name,
        issueTypeName: newJiraIssueTargetType?.name
      })
      if (nonce !== generationNonceRef.current) {
        return
      }
      if (!result.success) {
        if (!result.canceled) {
          toast.error(
            result.error ||
              translate(
                'components.jiraIssueTitleField.failed',
                'Failed to generate a summary from the description.'
              )
          )
        }
        return
      }
      // Why: a title the user typed during generation wins over the late result.
      setNewJiraIssueTitle((current) => (current === titleAtStart ? result.summary : current))
    } catch (error) {
      if (nonce === generationNonceRef.current) {
        toast.error(
          error instanceof Error
            ? error.message
            : translate(
                'components.jiraIssueTitleField.failed',
                'Failed to generate a summary from the description.'
              )
        )
      }
    } finally {
      // A late completion must not clear a newer request’s progress.
      if (nonce === generationNonceRef.current || !generatingRef.current) {
        generatingRef.current = false
        setNewJiraIssueSummaryGenerating(false)
      }
    }
  }, [
    newJiraIssueSummaryAvailable,
    newJiraIssueOpen,
    newJiraIssueBody,
    newJiraIssueSubmitting,
    newJiraIssueTargetProject,
    newJiraIssueTargetType,
    newJiraIssueTitle,
    setNewJiraIssueTitle
  ])

  return Object.assign(model, {
    newJiraIssueSummaryAvailable,
    newJiraIssueSummaryGenerating,
    handleGenerateNewJiraIssueSummary,
    handleCancelNewJiraIssueSummaryGeneration
  })
}

export type TaskPageJiraSummaryGenerationModel = TaskPageJiraIssueCreationModel &
  ReturnType<typeof useTaskPageJiraSummaryGeneration>
