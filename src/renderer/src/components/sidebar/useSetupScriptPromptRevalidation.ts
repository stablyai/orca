import { useEffect, useRef } from 'react'
import { useAppStore } from '@/store'
import { isGitRepoKind } from '../../../../shared/repo-kind'
import type { Repo } from '../../../../shared/repo-types'
import { getRepoHostIdentity } from '@/store/slices/repo-host-identity'
import { getRepoExecutionHostId, parseExecutionHostId } from '../../../../shared/execution-host'
import type { SetupScriptPromptState } from './setup-script-prompt-render-state'

/** Revisiting an already-activated worktree re-inspects at most this often. */
export const SETUP_PROMPT_REVISIT_REVALIDATION_INTERVAL_MS = 30_000

/** Reinspect external setup changes so stale setup prompts can clear without reopening the sidebar. */
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
  // Subscribe to the repo’s owning runtime so unrelated reconnects do not trigger inspections.
  const repoConnectionGeneration = useAppStore((s) =>
    repoRuntimeEnvironmentId
      ? (s.runtimeStatusByEnvironmentId.get(repoRuntimeEnvironmentId)?.connectionGeneration ?? 0)
      : 0
  )

  // Revalidate stale negative/failed results; forbidden or already-effective setup needs no extra RPC.
  const promptBelongsToActiveRepo =
    promptState?.repoId === activeRepo?.id &&
    Boolean(activeRepo && promptState?.repoHostIdentity === activeRepoHostIdentity)
  const promptNeedsRevalidation =
    promptBelongsToActiveRepo &&
    (promptState?.status === 'error' ||
      promptState?.status === 'distro-stopped' ||
      (promptState?.status === 'ok' && !promptState.hasEffectiveSetup))

  // Focus may reveal disk or terminal changes that React inputs cannot observe.
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

  // Creation hooks may settle on first activation; initial inspection already covers mount/remount.
  const previousWorktreeIdRef = useRef(activeWorktreeId)
  const previousRepoHostIdentityRef = useRef(activeRepoHostIdentity)
  const previousConnectionGenerationRef = useRef(repoConnectionGeneration)
  // Remember activation/reconnect signals while inspection clears prompt state, then replay them once eligible.
  const pendingRevalidationRef = useRef(false)
  // Track first activation and throttle revisits to avoid two remote calls per workspace click.
  const activatedWorktreeIdsRef = useRef(
    new Set<string>(activeWorktreeId ? [activeWorktreeId] : [])
  )
  const lastActivationRevalidationAtRef = useRef(Number.NEGATIVE_INFINITY)

  useEffect(() => {
    const worktreeChanged = previousWorktreeIdRef.current !== activeWorktreeId
    const hostChanged = previousRepoHostIdentityRef.current !== activeRepoHostIdentity
    // Reconnect can make an unreadable setup file readable without changing any other prompt input.
    const reconnected = repoConnectionGeneration > previousConnectionGenerationRef.current
    previousWorktreeIdRef.current = activeWorktreeId
    previousRepoHostIdentityRef.current = activeRepoHostIdentity
    previousConnectionGenerationRef.current = repoConnectionGeneration
    if (hostChanged) {
      // A repo/host switch re-runs the card's own inspection, so no extra pass is owed.
      pendingRevalidationRef.current = false
    } else if (reconnected) {
      pendingRevalidationRef.current = true
    } else if (worktreeChanged) {
      const firstActivation =
        activeWorktreeId !== null && !activatedWorktreeIdsRef.current.has(activeWorktreeId)
      if (activeWorktreeId !== null) {
        activatedWorktreeIdsRef.current.add(activeWorktreeId)
      }
      if (
        firstActivation ||
        Date.now() - lastActivationRevalidationAtRef.current >=
          SETUP_PROMPT_REVISIT_REVALIDATION_INTERVAL_MS
      ) {
        pendingRevalidationRef.current = true
      }
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
    lastActivationRevalidationAtRef.current = Date.now()
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
