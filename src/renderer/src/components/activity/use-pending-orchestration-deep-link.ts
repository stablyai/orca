import { useEffect } from 'react'
import { useAppStore } from '@/store'

export function usePendingOrchestrationDeepLink(): void {
  const pendingOrchestrationDeepLink = useAppStore((s) => s.pendingOrchestrationDeepLink)
  const clearPendingOrchestrationDeepLink = useAppStore((s) => s.clearPendingOrchestrationDeepLink)
  const repos = useAppStore((s) => s.repos)
  const reposFetchGeneration = useAppStore((s) => s.reposFetchGeneration)

  useEffect(() => {
    if (!pendingOrchestrationDeepLink) {
      return
    }
    const rawRepo = pendingOrchestrationDeepLink.repo?.trim()
    if (rawRepo && repos.length === 0 && reposFetchGeneration === 0) {
      return
    }
    let cancelled = false
    const applyDeepLink = () => {
      if (cancelled) {
        return
      }
      const state = useAppStore.getState()
      const currentRepos = state.repos ?? []
      const matchedRepo = rawRepo
        ? (currentRepos.find((r) => r.id === rawRepo) ??
          currentRepos.find((r) => r.displayName?.toLowerCase() === rawRepo.toLowerCase()) ??
          currentRepos.find(
            (r) => r.path?.split(/[\\/]/).findLast(Boolean)?.toLowerCase() === rawRepo.toLowerCase()
          ) ??
          null)
        : null
      const resolvedRepoId = matchedRepo?.id
      const unmatchedProjectId = rawRepo && !matchedRepo ? rawRepo : undefined
      const combinedPrompt = [
        pendingOrchestrationDeepLink.prompt,
        pendingOrchestrationDeepLink.objective
      ]
        .filter(Boolean)
        .join('\n\n')
      state.setNewWorkspaceDraft({
        repoId: resolvedRepoId ?? null,
        ...(unmatchedProjectId ? { projectId: unmatchedProjectId } : {}),
        name: pendingOrchestrationDeepLink.title ?? '',
        prompt: combinedPrompt,
        note: pendingOrchestrationDeepLink.objective ?? '',
        attachments: [],
        linkedWorkItem: null,
        agent: state.newWorkspaceDraft?.agent ?? 'claude',
        linkedIssue: '',
        linkedPR: null
      })
      state.openModal('new-workspace-composer', {
        prefilledName: pendingOrchestrationDeepLink.title,
        ...(resolvedRepoId ? { initialRepoId: resolvedRepoId } : {}),
        ...(unmatchedProjectId
          ? { initialWorkspaceTarget: { projectId: unmatchedProjectId, hostId: 'local' } }
          : {}),
        telemetrySource: 'unknown'
      })
      clearPendingOrchestrationDeepLink()
    }

    const settlePromise =
      rawRepo && repos.length === 0
        ? useAppStore.getState().awaitLocalRepoCatalogSettlement?.()
        : undefined
    if (settlePromise && typeof settlePromise.then === 'function') {
      void settlePromise.then(applyDeepLink, applyDeepLink)
    } else {
      applyDeepLink()
    }
    return () => {
      cancelled = true
    }
  }, [clearPendingOrchestrationDeepLink, pendingOrchestrationDeepLink, repos, reposFetchGeneration])
}
