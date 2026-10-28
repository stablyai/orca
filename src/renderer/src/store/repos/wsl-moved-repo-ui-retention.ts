/**
 * A moved project's repo-scoped UI (filters, hook trust, setup-prompt dismissals) survives a
 * catalog prune: its local row is hidden once the WSL host owns it, and the host's row is missing
 * whenever that host's catalog has not loaded. Without a moved project every result is the input.
 */
import type { WslMovedProject } from '../../../../shared/wsl-move/wsl-moved-project'
import {
  getSetupScriptPromptDismissalRepoId,
  sanitizeSetupScriptPromptDismissals
} from '@/lib/setup-script-prompt'

// Undefined in partial test stores and older state shapes; treated as no moved project.
type MovedProjects = readonly WslMovedProject[] | undefined

function movedRepoIds(projects: MovedProjects): Set<string> {
  return new Set(
    (projects ?? []).flatMap((project) => (project.kind === 'repo' ? [project.id] : []))
  )
}

/** `validRepoIds` plus the moved repos. */
export function withWslMovedRepoIds(
  validRepoIds: Set<string>,
  projects: MovedProjects
): Set<string> {
  const missing = [...movedRepoIds(projects)].filter((id) => !validRepoIds.has(id))
  return missing.length === 0 ? validRepoIds : new Set([...validRepoIds, ...missing])
}

/** `retained` plus every persisted dismissal of a moved repo, whichever host it names. */
export function withWslMovedSetupScriptDismissals(
  persisted: unknown,
  retained: readonly string[],
  projects: MovedProjects
): readonly string[] {
  const moved = movedRepoIds(projects)
  if (moved.size === 0) {
    return retained
  }
  const kept = sanitizeSetupScriptPromptDismissals(persisted).filter(
    (entry) => !retained.includes(entry) && moved.has(getSetupScriptPromptDismissalRepoId(entry))
  )
  if (kept.length === 0) {
    return retained
  }
  const next = [...retained, ...kept]
  // Nothing pruned: hand back the persisted array, so subscribers see no change.
  return Array.isArray(persisted) &&
    persisted.length === next.length &&
    next.every((entry) => persisted.includes(entry))
    ? persisted
    : next
}
