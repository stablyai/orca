import { useEffect, useRef } from 'react'
import { useAppStore } from '@/store'
import { isGitRepoKind } from '../../../../shared/repo-kind'
import type { Repo } from '../../../../shared/repo-types'
import { getRepoHostIdentity } from '@/store/slices/repo-host-identity'
import { getRepoExecutionHostId, parseExecutionHostId } from '../../../../shared/execution-host'
import type { SetupScriptPromptState } from './setup-script-prompt-render-state'

/**
 * Re-runs the setup-script prompt inspection when a shared `orca.yaml` setup hook
 * can have become effective outside SetupScriptPromptCard's reactive inputs, so a
 * stale "Add a setup script" prompt clears without a full sidebar reopen.
 */
export function useSetupScriptPromptRevalidation(input: {
  activeRepo: Repo | null
  isDismissed: boolean
  sidebarOpen: boolean
  promptState: SetupScriptPromptState | null
  requestRevalidation: () => void
}): void {
  const { activeRepo, isDismissed, sidebarOpen, promptState, requestRevalidation } = input
  const activeWorktreeId = useAppStore((s) => s.activeWorktreeId)
  const activeRepoHostIdentity = activeRepo ? getRepoHostIdentity(activeRepo) : null
  const repoHost = parseExecutionHostId(activeRepo ? getRepoExecutionHostId(activeRepo) : null)
  const repoRuntimeEnvironmentId = repoHost?.kind === 'runtime' ? repoHost.environmentId : null
  // Why: scope to the repo's own runtime so an unrelated host reconnect does not
  // re-fire inspections for every repo.
  const repoConnectionGeneration = useAppStore((s) =>
    repoRuntimeEnvironmentId
      ? (s.runtimeStatusByEnvironmentId.get(repoRuntimeEnvironmentId)?.connectionGeneration ?? 0)
      : 0
  )

  // Why: revalidate while the prompt shows no effective setup or a failed inspection —
  // both can be stale. `forbidden` is permanent and an effective setup has nothing to
  // clear, so neither is worth an RPC (notably over SSH).
  const promptBelongsToActiveRepo =
    promptState?.repoId === activeRepo?.id &&
    Boolean(activeRepo && promptState?.repoHostIdentity === activeRepoHostIdentity)
  const promptNeedsRevalidation =
    promptBelongsToActiveRepo &&
    (promptState?.status === 'error' ||
      (promptState?.status === 'ok' && !promptState.hasEffectiveSetup))

  // Why: orca.yaml is edited on disk or the hook runs in a terminal outside React
  // state. Re-inspect on window focus so returning to Orca detects it (mirrors
  // useInstalledAgentSkills' focus revalidation).
  useEffect(() => {
    if (
      !sidebarOpen ||
      !activeRepo ||
      !isGitRepoKind(activeRepo) ||
      isDismissed ||
      !promptNeedsRevalidation
    ) {
      return
    }
    window.addEventListener('focus', requestRevalidation)
    return () => {
      window.removeEventListener('focus', requestRevalidation)
    }
  }, [activeRepo, isDismissed, requestRevalidation, promptNeedsRevalidation, sidebarOpen])

  // Why: the setup hook runs during worktree creation, so activating a worktree in
  // this repo can make the setup effective after a negative result was cached. Fire
  // only on an actual activation change, not on mount/remount with a seeded id —
  // the initial inspection already covers the mounted worktree.
  const previousWorktreeIdRef = useRef(activeWorktreeId)
  const previousRepoHostIdentityRef = useRef(activeRepoHostIdentity)
  const previousConnectionGenerationRef = useRef(repoConnectionGeneration)
  // Why: these signals usually land while the prompt state is still unsettled (the
  // card nulls it for the whole inspection round trip). Remember them instead of
  // dropping them, then replay once a revalidatable result exists.
  const pendingRevalidationRef = useRef(false)

  useEffect(() => {
    const worktreeChanged = previousWorktreeIdRef.current !== activeWorktreeId
    const hostChanged = previousRepoHostIdentityRef.current !== activeRepoHostIdentity
    // Why: a runtime reconnect can turn an unreadable orca.yaml into a readable one,
    // and nothing else in the card's inputs changes when that happens.
    const reconnected = repoConnectionGeneration > previousConnectionGenerationRef.current
    previousWorktreeIdRef.current = activeWorktreeId
    previousRepoHostIdentityRef.current = activeRepoHostIdentity
    previousConnectionGenerationRef.current = repoConnectionGeneration
    if (hostChanged) {
      // A repo/host switch re-runs the card's own inspection, so no extra pass is owed.
      pendingRevalidationRef.current = false
    } else if (worktreeChanged || reconnected) {
      pendingRevalidationRef.current = true
    }

    if (
      !pendingRevalidationRef.current ||
      !sidebarOpen ||
      !activeRepo ||
      !isGitRepoKind(activeRepo) ||
      isDismissed ||
      !promptNeedsRevalidation
    ) {
      return
    }
    pendingRevalidationRef.current = false
    requestRevalidation()
  }, [
    activeRepo,
    activeRepoHostIdentity,
    activeWorktreeId,
    isDismissed,
    promptNeedsRevalidation,
    repoConnectionGeneration,
    requestRevalidation,
    sidebarOpen
  ])
}
