import { useEffect, useRef } from 'react'
import { useAppStore } from '@/store'
import type { SetupScriptPromptInspection } from '@/lib/setup-script-prompt'
import { isGitRepoKind } from '../../../../shared/repo-kind'
import type { Repo } from '../../../../shared/types'

/**
 * Re-runs the setup-script prompt inspection when a shared `orca.yaml` setup hook
 * can have become effective outside SetupScriptPromptCard's reactive inputs, so a
 * stale "Add a setup script" prompt clears without a full sidebar reopen.
 */
export function useSetupScriptPromptRevalidation(input: {
  activeRepo: Repo | null
  isDismissed: boolean
  sidebarOpen: boolean
  promptState: SetupScriptPromptInspection | null
  requestRevalidation: () => void
}): void {
  const { activeRepo, isDismissed, sidebarOpen, promptState, requestRevalidation } = input
  const activeWorktreeId = useAppStore((s) => s.activeWorktreeId)

  // Why: only revalidate while the prompt still shows no effective setup — there is
  // nothing to clear (and no RPC worth spending, notably over SSH) once it is
  // configured.
  const showsMissingSetup =
    promptState?.status === 'ok' &&
    promptState.repoId === activeRepo?.id &&
    !promptState.hasEffectiveSetup

  // Why: orca.yaml is edited on disk or the hook runs in a terminal outside React
  // state. Re-inspect on window focus so returning to Orca detects it (mirrors
  // useInstalledAgentSkills' focus revalidation).
  useEffect(() => {
    if (
      !sidebarOpen ||
      !activeRepo ||
      !isGitRepoKind(activeRepo) ||
      isDismissed ||
      !showsMissingSetup
    ) {
      return
    }
    window.addEventListener('focus', requestRevalidation)
    return () => {
      window.removeEventListener('focus', requestRevalidation)
    }
  }, [activeRepo, isDismissed, requestRevalidation, showsMissingSetup, sidebarOpen])

  // Why: the setup hook runs during worktree creation, so activating a worktree in
  // this repo can make the setup effective after a negative result was cached. Fire
  // only on an actual activation change, not on mount/remount with a seeded id —
  // the initial inspection already covers the mounted worktree.
  const previousWorktreeIdRef = useRef(activeWorktreeId)
  useEffect(() => {
    const changed = previousWorktreeIdRef.current !== activeWorktreeId
    previousWorktreeIdRef.current = activeWorktreeId
    if (changed && showsMissingSetup) {
      requestRevalidation()
    }
  }, [activeWorktreeId, requestRevalidation, showsMissingSetup])
}
