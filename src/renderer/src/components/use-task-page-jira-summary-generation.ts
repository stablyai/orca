import { useCallback, useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import type { TaskPageJiraIssueCreationModel } from './use-task-page-jira-issue-creation'

export function useTaskPageJiraSummaryGeneration(model: TaskPageJiraIssueCreationModel) {
  const {
    newJiraIssueOpen,
    newJiraIssueTitle,
    newJiraIssueBody,
    newJiraIssueSubmitting,
    newJiraIssueTargetProject,
    newJiraIssueTargetType,
    setNewJiraIssueTitle
  } = model
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
    void window.api.jira.cancelGenerateIssueSummary()
  }, [])

  // Why: closing the dialog abandons the request; without invalidating it a
  // late result would overwrite the title typed on the next open. Refs only —
  // the visible flag resets in the request's finally block.
  useEffect(() => {
    if (newJiraIssueOpen || !generatingRef.current) {
      return
    }
    generationNonceRef.current += 1
    generatingRef.current = false
    void window.api.jira.cancelGenerateIssueSummary()
  }, [newJiraIssueOpen])

  // Why: unmounting the page must not strand a running generation on the host.
  useEffect(
    () => () => {
      if (generatingRef.current) {
        generationNonceRef.current += 1
        generatingRef.current = false
        void window.api.jira.cancelGenerateIssueSummary()
      }
    },
    []
  )

  const handleGenerateNewJiraIssueSummary = useCallback(async (): Promise<void> => {
    const description = newJiraIssueBody.trim()
    if (!description || generatingRef.current || newJiraIssueSubmitting) {
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
                'auto.components.use.task.page.jira.summary.generation.3de3ec2d25',
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
                'auto.components.use.task.page.jira.summary.generation.3de3ec2d25',
                'Failed to generate a summary from the description.'
              )
        )
      }
    } finally {
      // Why: also clears the flag for a request abandoned by dialog close,
      // where the nonce no longer matches but no newer request is running.
      if (nonce === generationNonceRef.current || !generatingRef.current) {
        generatingRef.current = false
        setNewJiraIssueSummaryGenerating(false)
      }
    }
  }, [
    newJiraIssueBody,
    newJiraIssueSubmitting,
    newJiraIssueTargetProject,
    newJiraIssueTargetType,
    newJiraIssueTitle,
    setNewJiraIssueTitle
  ])

  // Why: mutates the accumulating model like every other chain hook, but
  // Object.assign's checked T & U return needs no type assertion.
  return Object.assign(model, {
    newJiraIssueSummaryGenerating,
    handleGenerateNewJiraIssueSummary,
    handleCancelNewJiraIssueSummaryGeneration
  })
}

export type TaskPageJiraSummaryGenerationModel = ReturnType<typeof useTaskPageJiraSummaryGeneration>
