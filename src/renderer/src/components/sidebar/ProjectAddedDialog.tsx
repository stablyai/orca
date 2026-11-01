import { useEffect, useRef } from 'react'
import { useAppStore } from '@/store'
import { activateAndRevealWorktree } from '@/lib/worktree-activation'
import { isFolderRepo } from '../../../../shared/repo-kind'
import { finishProjectAddWithDefaultCheckout } from './project-added-default-checkout'
import { selectWorktreesByRepo } from '@/store/workspace-record-selectors'

type ProjectAddedModalData = {
  repoId?: string
  projectId?: string
}

export default function ProjectAddedDialog(): null {
  const activeModal = useAppStore((s) => s.activeModal)
  const modalData = useAppStore((s) => s.modalData as ProjectAddedModalData)
  const closeModal = useAppStore((s) => s.closeModal)
  const repos = useAppStore((s) => s.repos)
  const fetchReposForAllHosts = useAppStore((s) => s.fetchReposForAllHosts)
  const fetchWorktrees = useAppStore((s) => s.fetchWorktrees)
  const setHideDefaultBranchWorkspace = useAppStore((s) => s.setHideDefaultBranchWorkspace)
  const handoffRunRef = useRef(0)
  const pendingRepoHydrationRef = useRef<string | null>(null)

  // Accept legacy projectId so old onboarding modals cannot block contextual tours.
  const repoId =
    typeof modalData?.repoId === 'string'
      ? modalData.repoId
      : typeof modalData?.projectId === 'string'
        ? modalData.projectId
        : ''
  const repo = repos.find((candidate) => candidate.id === repoId) ?? null

  useEffect(() => {
    if (activeModal !== 'project-added') {
      handoffRunRef.current++
      pendingRepoHydrationRef.current = null
      return
    }
    if (!repoId) {
      closeModal()
      return
    }
    if (!repo) {
      if (pendingRepoHydrationRef.current === repoId) {
        return
      }
      pendingRepoHydrationRef.current = repoId
      let cancelled = false
      void (async () => {
        // The new repo’s host is not loaded yet; hydrate repositories across hosts.
        await fetchReposForAllHosts()
        if (cancelled) {
          return
        }
        const hydratedRepo = useAppStore
          .getState()
          .repos.find((candidate) => candidate.id === repoId)
        if (!hydratedRepo) {
          closeModal()
        }
        pendingRepoHydrationRef.current = null
      })()
      return () => {
        cancelled = true
        pendingRepoHydrationRef.current = null
      }
    }
    pendingRepoHydrationRef.current = null
    const runId = ++handoffRunRef.current

    let cancelled = false
    if (isFolderRepo(repo)) {
      void (async () => {
        try {
          await fetchWorktrees(repoId)
        } catch {
          // This compatibility handoff must close even if synthetic folder refresh fails.
        }
        if (cancelled) {
          return
        }
        const folderWorktree = selectWorktreesByRepo(useAppStore.getState())[repoId]?.[0]
        if (folderWorktree) {
          activateAndRevealWorktree(folderWorktree.id, { sidebarRevealBehavior: 'auto' })
        }
        closeModal()
      })()
      return () => {
        cancelled = true
      }
    }

    void (async () => {
      try {
        await fetchWorktrees(repoId)
      } catch {
        // Fall back to loaded worktree state so compatibility failures cannot strand stale modals.
      }
      if (!cancelled && handoffRunRef.current === runId) {
        await finishProjectAddWithDefaultCheckout({
          repoId,
          source: 'project_added_compat',
          closeModal,
          setHideDefaultBranchWorkspace
        })
      }
    })()
    return () => {
      cancelled = true
    }
  }, [
    activeModal,
    closeModal,
    fetchReposForAllHosts,
    fetchWorktrees,
    repo,
    repoId,
    setHideDefaultBranchWorkspace
  ])

  return null
}
