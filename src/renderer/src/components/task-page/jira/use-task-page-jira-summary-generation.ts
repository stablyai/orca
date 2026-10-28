import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createNonSecureContextUuid as createBrowserUuid } from '../../../../../shared/non-secure-context-uuid'
import { isWebClientLocation } from '@/lib/web-client-location'
import { ipcOrRuntimeTargetForHostId } from '@/runtime/runtime-client-target'
import {
  generateRuntimeJiraIssueSummary,
  cancelRuntimeJiraIssueSummary
} from '@/runtime/runtime-jira-summary-generation-client'
import type { RuntimeClientTarget } from '../../../../../shared/runtime-client-target'
import type { JiraIssueSummaryGenerationRequest } from '../../../../../shared/jira/jira-issue-summary-generation'
import { getTaskSourceCacheScope } from '../../../../../shared/task-source-context'
import { translate } from '@/i18n/i18n'
import type { TaskPageJiraIssueCreationModel } from './use-task-page-jira-issue-creation'

type SummaryGenerationModel = Pick<
  TaskPageJiraIssueCreationModel,
  | 'accountBackedTaskSourceHostId'
  | 'jiraTaskSourceContext'
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
    accountBackedTaskSourceHostId,
    jiraTaskSourceContext,
    newJiraIssueOpen,
    newJiraIssueTitle,
    newJiraIssueBody,
    newJiraIssueSubmitting,
    newJiraIssueTargetProject,
    newJiraIssueTargetType,
    setNewJiraIssueTitle,
    providerRuntimeContextKey
  } = model
  const ownerHostId = jiraTaskSourceContext?.hostId ?? accountBackedTaskSourceHostId
  const target = useMemo(() => ipcOrRuntimeTargetForHostId(ownerHostId), [ownerHostId])
  const newJiraIssueSummaryAvailable = !isWebClientLocation()
  const [newJiraIssueSummaryGenerating, setNewJiraIssueSummaryGenerating] = useState(false)
  const jiraSourceKey = jiraTaskSourceContext
    ? getTaskSourceCacheScope(jiraTaskSourceContext)
    : ownerHostId
  const draftKey = JSON.stringify([
    newJiraIssueBody,
    newJiraIssueTargetProject?.siteId,
    newJiraIssueTargetProject?.id,
    newJiraIssueTargetType?.id,
    providerRuntimeContextKey,
    jiraSourceKey
  ])
  const [generationError, setGenerationError] = useState<{
    draftKey: string
    message: string
  } | null>(null)
  const newJiraIssueSummaryError =
    generationError?.draftKey === draftKey ? generationError.message : null
  const generationNonceRef = useRef(0)
  const generatingRef = useRef(false)
  const [draftId] = useState(() => createBrowserUuid())
  const titleRevisionRef = useRef(0)
  const requestRef = useRef<{
    target: RuntimeClientTarget
    args: JiraIssueSummaryGenerationRequest
    abort: AbortController
  } | null>(null)
  const cancelRequest = useCallback(() => {
    const request = requestRef.current
    requestRef.current = null
    if (request) {
      request.abort.abort()
      void cancelRuntimeJiraIssueSummary(request.target, request.args).catch(() => {})
    }
  }, [])
  const handleNewJiraIssueTitleChange = useCallback(
    (value: string) => {
      titleRevisionRef.current += 1
      setNewJiraIssueTitle(value)
    },
    [setNewJiraIssueTitle]
  )

  const handleCancelNewJiraIssueSummaryGeneration = useCallback((): void => {
    if (!generatingRef.current) {
      return
    }
    generationNonceRef.current += 1
    generatingRef.current = false
    setNewJiraIssueSummaryGenerating(false)
    cancelRequest()
  }, [cancelRequest])

  // Changing or abandoning a draft invalidates the external generation, including on unmount.
  useEffect(
    () => () => {
      if (!generatingRef.current) {
        return
      }
      const canceledNonce = ++generationNonceRef.current
      generatingRef.current = false
      cancelRequest()
      if (generationNonceRef.current === canceledNonce) {
        setNewJiraIssueSummaryGenerating(false)
      }
    },
    [
      newJiraIssueOpen,
      newJiraIssueBody,
      newJiraIssueTargetProject?.siteId,
      newJiraIssueTargetProject?.id,
      newJiraIssueTargetType?.id,
      providerRuntimeContextKey,
      jiraSourceKey,
      cancelRequest
    ]
  )

  const handleGenerateNewJiraIssueSummary = useCallback(async (): Promise<void> => {
    const description = newJiraIssueBody.trim()
    if (
      !newJiraIssueSummaryAvailable ||
      !newJiraIssueOpen ||
      !description ||
      !newJiraIssueTargetProject?.siteId ||
      !target ||
      generatingRef.current ||
      newJiraIssueSubmitting
    ) {
      return
    }
    const nonce = ++generationNonceRef.current
    const titleAtStart = newJiraIssueTitle
    const titleRevisionAtStart = titleRevisionRef.current
    const request = {
      target,
      args: {
        siteId: newJiraIssueTargetProject.siteId,
        requestId: createBrowserUuid(),
        draftId,
        description,
        projectName: newJiraIssueTargetProject.name,
        issueTypeName: newJiraIssueTargetType?.name
      },
      abort: new AbortController()
    }
    requestRef.current = request
    generatingRef.current = true
    setNewJiraIssueSummaryGenerating(true)
    setGenerationError(null)
    try {
      const result = await generateRuntimeJiraIssueSummary(
        request.target,
        request.args,
        request.abort.signal
      )
      if (nonce !== generationNonceRef.current) {
        return
      }
      if (!result.success) {
        if (!result.canceled) {
          setGenerationError({
            draftKey,
            message:
              result.error ||
              translate(
                'components.jiraIssueTitleField.failed',
                'Failed to generate a summary from the description.'
              )
          })
        }
        return
      }
      // Why: a title the user typed during generation wins over the late result.
      if (titleRevisionRef.current === titleRevisionAtStart) {
        setNewJiraIssueTitle((current) => (current === titleAtStart ? result.summary : current))
      }
    } catch (error) {
      if (nonce === generationNonceRef.current) {
        setGenerationError({
          draftKey,
          message:
            error instanceof Error
              ? error.message
              : translate(
                  'components.jiraIssueTitleField.failed',
                  'Failed to generate a summary from the description.'
                )
        })
      }
    } finally {
      // A late completion must not clear a newer request’s progress.
      if (nonce === generationNonceRef.current) {
        requestRef.current = null
        generatingRef.current = false
        setNewJiraIssueSummaryGenerating(false)
      }
    }
  }, [
    newJiraIssueSummaryAvailable,
    draftKey,
    draftId,
    target,
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
    newJiraIssueSummaryError,
    handleGenerateNewJiraIssueSummary,
    handleNewJiraIssueTitleChange,
    handleCancelNewJiraIssueSummaryGeneration
  })
}

export type TaskPageJiraSummaryGenerationModel = TaskPageJiraIssueCreationModel &
  ReturnType<typeof useTaskPageJiraSummaryGeneration>
