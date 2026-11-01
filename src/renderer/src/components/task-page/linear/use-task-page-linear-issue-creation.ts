import { getLinearSourceScope } from '@/store/slices/linear/linear-slice-scope'
import { observeLinearIssueRead } from '@/store/slices/linear/linear-issue-publication'
import { taskProviderErrorMessage } from '@/lib/task-provider-error-copy'
import type { TaskPageLinearProjectCreationModel } from './use-task-page-linear-project-creation'
import { useCallback, useLayoutEffect, useMemo, useRef } from 'react'
import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { linearCreateIssue } from '@/runtime/runtime-linear-issue-mutations'
import { useAppStore } from '@/store'
import { defaultScopeSource } from '@/lib/default-creation-host'
import { openAppHttpLink } from '@/lib/app-http-link-open'
export function useTaskPageLinearIssueCreation(model: TaskPageLinearProjectCreationModel) {
  const {
    settings,
    providerRuntimeContextKey,
    providerRuntimeContextKeyRef,
    linearTaskSourceContext,
    setSelectedLinearIssue,
    setLinearRefreshNonce,
    selectedLinearProject,
    newLinearIssueTitle,
    newLinearIssueBody,
    newLinearIssueSubmitting,
    newLinearIssueStateId,
    newLinearIssueAssigneeId,
    newLinearIssuePriority,
    newLinearIssueProjectId,
    newLinearIssueLabelIds,
    newLinearIssueTargetTeam,
    captureNewLinearIssueDraft,
    completeNewLinearIssueDraft,
    beginNewLinearIssue,
    settleNewLinearIssue
  } = model
  const publication = useRef<{ release: () => void } | null>(null)
  const sourceSettings = linearTaskSourceContext ?? defaultScopeSource(settings)
  const scope = getLinearSourceScope(sourceSettings)
  const sourceKey = useAppStore(() => getLinearSourceScope(sourceSettings).contextKey)
  // oxlint-disable-next-line react-hooks/exhaustive-deps -- Why: the full source/runtime and stable request explicitly delimit the create lifetime.
  const lifetime = useMemo(() => ({ live: false }), [sourceKey, model.linearSelectionRequest])
  const committed = useRef<{
    lifetime: typeof lifetime
    source: typeof sourceSettings
    scope: typeof scope
    selection: object
    select: typeof setSelectedLinearIssue
  } | null>(null)
  useLayoutEffect(() => {
    lifetime.live = true
    return () => {
      lifetime.live = false
      publication.current?.release()
      publication.current = null
    }
  }, [lifetime])
  useLayoutEffect(() => {
    committed.current = {
      lifetime,
      source: sourceSettings,
      scope,
      selection: model.linearSelectionRequest,
      select: setSelectedLinearIssue
    }
  })
  const handleCreateNewLinearIssue = useCallback(async (): Promise<void> => {
    if (!newLinearIssueTargetTeam) {
      return
    }
    const title = newLinearIssueTitle.trim()
    if (!title || newLinearIssueSubmitting) {
      return
    }
    if (
      selectedLinearProject &&
      newLinearIssueProjectId === selectedLinearProject.id &&
      newLinearIssueTargetTeam.workspaceId !== selectedLinearProject.workspaceId
    ) {
      toast.error(
        translate(
          'auto.components.TaskPage.1e1b2ad8f2',
          'Select a team from the project workspace before filing this issue.'
        )
      )
      return
    }
    const origin = committed.current
    if (!origin?.lifetime.live || !origin.scope.isCurrentRuntime()) {
      return
    }
    const isLive = () =>
      origin.lifetime.live &&
      committed.current?.lifetime === origin.lifetime &&
      committed.current.selection === origin.selection &&
      origin.scope.isCurrentRuntime()
    const attempt = {}
    const submitted = captureNewLinearIssueDraft()
    beginNewLinearIssue(attempt)
    const submitProviderRuntimeContextKey = providerRuntimeContextKey
    const initialSelection = origin.selection
    publication.current?.release()
    publication.current = null
    try {
      const result = await linearCreateIssue(origin.source, {
        teamId: newLinearIssueTargetTeam.id,
        title,
        description: newLinearIssueBody || undefined,
        workspaceId: newLinearIssueTargetTeam.workspaceId,
        stateId: newLinearIssueStateId || undefined,
        priority: newLinearIssuePriority,
        assigneeId: newLinearIssueAssigneeId || undefined,
        projectId: newLinearIssueProjectId || null,
        labelIds: newLinearIssueLabelIds.length > 0 ? newLinearIssueLabelIds : undefined
      })
      if (
        !origin.scope.isCurrentRuntime() ||
        submitProviderRuntimeContextKey !== providerRuntimeContextKeyRef.current
      ) {
        return
      }
      if (!result.ok) {
        toast.error(
          taskProviderErrorMessage(result) ||
            translate('auto.components.TaskPage.7437e340b4', 'Failed to create issue.')
        )
        return
      }
      toast.success(
        translate('auto.components.TaskPage.cb98f0350c', 'Created {{value0}}', {
          value0: result.identifier
        }),
        {
          action: result.url
            ? {
                label: translate('auto.components.TaskPage.9c57663908', 'View'),
                onClick: () => openAppHttpLink(result.url)
              }
            : undefined
        }
      )
      completeNewLinearIssueDraft(submitted)
      if (!isLive()) {
        return
      }
      setLinearRefreshNonce((n) => n + 1)
      useAppStore.getState().recordFeatureInteraction('linear-tasks')

      let release = () => {}
      const observation = { release: () => release() }
      publication.current = observation
      release = observeLinearIssueRead(
        useAppStore.getState().fetchLinearIssue(result.id, newLinearIssueTargetTeam.workspaceId, {
          scope: origin.scope,
          force: true
        }),
        isLive,
        (lease, view) => {
          if (view.kind === 'data' && view.data && isLive()) {
            origin.select(view.data, {
              allowOutsideList: true,
              expectedSelection: initialSelection,
              isCurrent: () => lease.commit(view, false, () => true)
            })
          }
        }
      )
      if (!isLive() || publication.current !== observation) {
        release()
      }
    } finally {
      settleNewLinearIssue(attempt)
    }
  }, [
    newLinearIssueBody,
    newLinearIssueSubmitting,
    newLinearIssueTargetTeam,
    newLinearIssueTitle,
    newLinearIssueStateId,
    newLinearIssuePriority,
    newLinearIssueAssigneeId,
    newLinearIssueProjectId,
    newLinearIssueLabelIds,
    providerRuntimeContextKey,
    selectedLinearProject,
    providerRuntimeContextKeyRef,
    setLinearRefreshNonce,
    captureNewLinearIssueDraft,
    completeNewLinearIssueDraft,
    beginNewLinearIssue,
    settleNewLinearIssue
  ])
  const nextModel = Object.assign(model, { handleCreateNewLinearIssue })
  return nextModel
}
export type TaskPageLinearIssueCreationModel = ReturnType<typeof useTaskPageLinearIssueCreation>
