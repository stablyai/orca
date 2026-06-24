import { toast } from 'sonner'
import { useAppStore } from '@/store'
import { ORCASTRATOR_DISPLAY_PREFIX } from '@/store/slices/orchestrators'
import { translate } from '@/i18n/i18n'
import type { Project } from '../../../shared/types'

// Why: the director's own dedicated worktree — hidden from Projects, shown only in
// the ORCASTRATORS section (the display prefix), so a director never couples to the
// project's primary checkout. This is the shell BOTH director kinds share: the LLM
// Orcastrator seeds /orcastrate + an agent into it, while the token-free recipe
// director (#9) leaves it agent-free and uses it purely as the lineage anchor +
// `.orcastrate` log home + the coordinator's operating worktree.

export type DirectorWorktreeShell = {
  worktreeId: string
  setup: Awaited<ReturnType<ReturnType<typeof useAppStore.getState>['createWorktree']>>['setup']
}

/**
 * Create the hidden director worktree shell for a project. This creates ONLY the
 * worktree — it does NOT start an agent or seed any prompt, so it is token-free by
 * construction; callers layer agent startup on top when they want an LLM director.
 * Surfaces failures via toast and returns null (no repo / create failed).
 */
export async function createDirectorWorktreeShell(
  project: Project,
  options: { label: string }
): Promise<DirectorWorktreeShell | null> {
  const repoId = project.sourceRepoIds[0]
  if (!repoId) {
    toast.error(
      translate(
        'auto.lib.orchestrator.launch.no_repo',
        'This project has no repo to launch an Orcastrator in.'
      )
    )
    return null
  }

  const store = useAppStore.getState()
  const repo = store.repos.find((entry) => entry.id === repoId)
  try {
    // Why: 'skip' setup — a director coordinates, it doesn't build, so it does not
    // need the repo's setup scripts run in its checkout.
    // Token-free invariant (#9): this call MUST NOT pass `createdWithAgent`. The
    // shell is agent-free only because that arg stays undefined — otherwise
    // activateAndRevealWorktree's `opts?.startup ?? buildCreatedAgentReopenStartup(wt)`
    // fallback would relaunch an LLM in the director pane (a director-pane token
    // cost). The arg list intentionally stops at displayName for exactly this reason.
    const result = await store.createWorktree(
      repoId,
      `orcastrator-${options.label}`,
      repo?.worktreeBaseRef,
      'skip',
      undefined,
      undefined,
      `${ORCASTRATOR_DISPLAY_PREFIX}${options.label}`,
      // Why: positional args up to compareBaseRef are unused for a director
      // shell; the trailing options carries suppressActivation so a remote
      // (SSH) create reveals the worktree without switching the user's active
      // tab — matching the renderer-side activation suppression at the call site.
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      { suppressActivation: true }
    )
    return { worktreeId: result.worktree.id, setup: result.setup }
  } catch (error) {
    toast.error(
      error instanceof Error
        ? error.message
        : translate(
            'auto.lib.orchestrator.launch.create_failed',
            'Failed to create the Orcastrator.'
          )
    )
    return null
  }
}
