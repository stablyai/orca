import type { TaskPageJiraListEffectsModel } from './use-task-page-jira-list-effects'
import { useCallback, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import { resolveSourceControlAiEnabled } from '../../../shared/source-control-ai'

export function useTaskPageGitHubIssueGeneration(model: TaskPageJiraListEffectsModel) {
  const {
    settings,
    perRepoSourceState,
    newIssueTitle,
    setNewIssueTitle,
    newIssueBody,
    setNewIssueBody,
    newIssueLabels,
    setNewIssueLabels,
    newIssueRepoLabels,
    newIssueSubmitting,
    newIssueTargetRepo,
    newIssueRuntimeTarget
  } = model
  const [newIssueGenerating, setNewIssueGenerating] = useState(false)
  const [newIssueGenerateError, setNewIssueGenerateError] = useState<string | null>(null)
  const generationRequestIdRef = useRef(0)
  const inFlightTargetRef = useRef<{ path: string; connectionId: string | null } | null>(null)
  // Why: the resolve closure holds click-time state; the ref exposes the live target so a
  // repo switched mid-flight (e.g. the vanished-repo fallback) never receives A's content.
  const currentTargetRepoIdRef = useRef<string | null>(null)
  currentTargetRepoIdRef.current = newIssueTargetRepo?.id ?? null

  const newIssueAiEnabled = useMemo(
    () =>
      settings ? resolveSourceControlAiEnabled({ settings, repo: newIssueTargetRepo }) : false,
    [newIssueTargetRepo, settings]
  )

  let newIssueGenerateDisabledReason: string | undefined
  if (newIssueSubmitting) {
    newIssueGenerateDisabledReason = translate(
      'auto.components.use.task.page.github.issue.generation.4c2d3431ed',
      'Wait for issue creation to finish.'
    )
  } else if (newIssueRuntimeTarget) {
    newIssueGenerateDisabledReason = translate(
      'auto.components.use.task.page.github.issue.generation.fb018f71b8',
      'Issue generation is unavailable for remote environments.'
    )
  } else if (!newIssueTitle.trim() && !newIssueBody.trim()) {
    newIssueGenerateDisabledReason = translate(
      'auto.components.use.task.page.github.issue.generation.8dfc617348',
      'Enter a title or description first.'
    )
  }

  const handleGenerateNewIssue = useCallback(async (): Promise<void> => {
    if (!newIssueTargetRepo || newIssueGenerating || newIssueSubmitting || newIssueRuntimeTarget) {
      return
    }
    if (!newIssueTitle.trim() && !newIssueBody.trim()) {
      return
    }
    const requestId = generationRequestIdRef.current + 1
    generationRequestIdRef.current = requestId
    // Why: the dialog locks the fields while generating, so the pre-generation draft is the undo seed.
    const seed = { title: newIssueTitle, body: newIssueBody, labels: newIssueLabels }
    const entry = perRepoSourceState.find((s) => s.repoId === newIssueTargetRepo.id)
    const repoSlug = entry?.sources?.issues
      ? `${entry.sources.issues.owner}/${entry.sources.issues.repo}`
      : null
    const startedRepoId = newIssueTargetRepo.id
    const connectionId = newIssueTargetRepo.connectionId ?? null
    inFlightTargetRef.current = { path: newIssueTargetRepo.path, connectionId }
    setNewIssueGenerating(true)
    setNewIssueGenerateError(null)
    try {
      const result = await window.api.git.generateIssueFields({
        worktreePath: newIssueTargetRepo.path,
        repoId: newIssueTargetRepo.id,
        ...(connectionId ? { connectionId } : {}),
        title: newIssueTitle,
        body: newIssueBody,
        repoSlug,
        availableLabels: newIssueRepoLabels.data ?? []
      })
      if (generationRequestIdRef.current !== requestId) {
        return
      }
      // Why: labels and repo context were generated for the started repo; a target that
      // changed mid-flight must not receive them.
      if (currentTargetRepoIdRef.current !== startedRepoId) {
        return
      }
      if (!result.success) {
        if (!result.canceled) {
          setNewIssueGenerateError(result.error)
        }
        return
      }
      setNewIssueTitle(result.fields.title)
      setNewIssueBody(result.fields.body)
      // Why: keep the user's own label picks; generated labels only add to them.
      setNewIssueLabels([...new Set([...seed.labels, ...result.fields.labels])])
      useAppStore.getState().recordFeatureInteraction('ai-issue-generation')
      toast.success(
        translate(
          'auto.components.use.task.page.github.issue.generation.835a4cd82e',
          'Issue details generated.'
        ),
        {
          action: {
            label: translate(
              'auto.components.use.task.page.github.issue.generation.0147080ec2',
              'Undo'
            ),
            onClick: () => {
              setNewIssueTitle(seed.title)
              setNewIssueBody(seed.body)
              setNewIssueLabels(seed.labels)
            }
          }
        }
      )
    } catch (error) {
      if (generationRequestIdRef.current !== requestId) {
        return
      }
      setNewIssueGenerateError(
        error instanceof Error
          ? error.message
          : translate(
              'auto.components.use.task.page.github.issue.generation.e45c7181da',
              'Failed to generate issue details.'
            )
      )
    } finally {
      if (generationRequestIdRef.current === requestId) {
        inFlightTargetRef.current = null
        setNewIssueGenerating(false)
      }
    }
  }, [
    newIssueBody,
    newIssueGenerating,
    newIssueLabels,
    newIssueRepoLabels.data,
    newIssueRuntimeTarget,
    newIssueSubmitting,
    newIssueTargetRepo,
    newIssueTitle,
    perRepoSourceState,
    setNewIssueBody,
    setNewIssueLabels,
    setNewIssueTitle
  ])

  // Why: also runs on dialog dismissal so no agent keeps running and no stale error greets the next open.
  const handleCancelGenerateNewIssue = useCallback((): void => {
    setNewIssueGenerateError(null)
    const target = inFlightTargetRef.current
    if (!target) {
      return
    }
    generationRequestIdRef.current += 1
    inFlightTargetRef.current = null
    setNewIssueGenerating(false)
    void window.api.git.cancelGenerateIssueFields({
      worktreePath: target.path,
      ...(target.connectionId ? { connectionId: target.connectionId } : {})
    })
  }, [])

  const nextModel = model as typeof model & {
    newIssueAiEnabled: typeof newIssueAiEnabled
    newIssueGenerating: typeof newIssueGenerating
    newIssueGenerateError: typeof newIssueGenerateError
    newIssueGenerateDisabledReason: typeof newIssueGenerateDisabledReason
    handleGenerateNewIssue: typeof handleGenerateNewIssue
    handleCancelGenerateNewIssue: typeof handleCancelGenerateNewIssue
  }
  nextModel.newIssueAiEnabled = newIssueAiEnabled
  nextModel.newIssueGenerating = newIssueGenerating
  nextModel.newIssueGenerateError = newIssueGenerateError
  nextModel.newIssueGenerateDisabledReason = newIssueGenerateDisabledReason
  nextModel.handleGenerateNewIssue = handleGenerateNewIssue
  nextModel.handleCancelGenerateNewIssue = handleCancelGenerateNewIssue
  return nextModel
}
export type TaskPageGitHubIssueGenerationModel = ReturnType<typeof useTaskPageGitHubIssueGeneration>
