import type { ExternalWorktreeVisibility, Repo } from '../../../../shared/repo-types'
import type { WorktreeVisibilityDefaults } from '../../../../shared/global-settings-types'
import {
  effectiveExternalWorktreeVisibility,
  isLegacyRepoForExternalWorktreeVisibility
} from '../../../../shared/external-worktree-visibility'
import {
  effectiveBuiltInWorktreeSourceVisibility,
  effectiveCustomWorktreeSourceVisibility,
  normalizeWorktreeVisibilitySourcePreferences
} from '../../../../shared/worktree/visibility-sources'
import {
  removeBuiltInWorktreeSourcePreference,
  removeCustomWorktreeSourcePreference
} from '../../../../shared/worktree/visibility-source-preferences'
import type { WorktreeVisibilitySourceRow } from './WorktreeVisibilitySourceList'
import type { WorktreeVisibilitySourceMutation } from './worktree-visibility-source-mutation'
import {
  getWorktreeVisibilitySourceProvenance,
  globalWorktreeVisibilitySourceValue
} from './worktree-visibility-source-provenance'

/**
 * Why: picking the value Global Settings already holds drops the project's override rather than
 * pinning a duplicate of it, so the same control both overrides and reverts (#14276).
 */
export function shouldUseGlobalWorktreeVisibility(
  repo: Repo,
  source: WorktreeVisibilitySourceRow,
  visibility: ExternalWorktreeVisibility,
  visibilityDefaults: WorktreeVisibilityDefaults | undefined,
  repoCustomSourceIds: ReadonlySet<string>
): boolean {
  const provenance = getWorktreeVisibilitySourceProvenance(
    repo,
    source,
    visibilityDefaults ?? {},
    repoCustomSourceIds
  )
  return (
    provenance?.kind === 'project-override' &&
    globalWorktreeVisibilitySourceValue(source, visibilityDefaults) === visibility
  )
}

export function createWorktreeVisibilityUseGlobalMutation(
  repo: Repo,
  source: WorktreeVisibilitySourceRow,
  visibilityDefaults: WorktreeVisibilityDefaults | undefined
): WorktreeVisibilitySourceMutation {
  if (source.kind === 'other') {
    return {
      updates: { externalWorktreeVisibility: null },
      isAccepted: (latestRepo) =>
        latestRepo.externalWorktreeVisibility === undefined &&
        effectiveExternalWorktreeVisibility(
          latestRepo,
          isLegacyRepoForExternalWorktreeVisibility(latestRepo),
          visibilityDefaults
        ) === effectiveExternalWorktreeVisibility({}, false, visibilityDefaults)
    }
  }
  if (source.kind === 'built-in') {
    return {
      updates: {
        agentWorktreeVisibility: null,
        worktreeVisibilitySourcePreferences: removeBuiltInWorktreeSourcePreference(repo, source.id)
      },
      isAccepted: (latestRepo) =>
        latestRepo.agentWorktreeVisibility === undefined &&
        normalizeWorktreeVisibilitySourcePreferences(latestRepo.worktreeVisibilitySourcePreferences)
          ?.builtIn?.[source.id] === undefined &&
        effectiveBuiltInWorktreeSourceVisibility(latestRepo, source.id, visibilityDefaults) ===
          effectiveBuiltInWorktreeSourceVisibility({}, source.id, visibilityDefaults)
    }
  }
  return {
    updates: {
      worktreeVisibilitySourcePreferences: removeCustomWorktreeSourcePreference(
        repo,
        source.source.id
      )
    },
    isAccepted: (latestRepo) =>
      normalizeWorktreeVisibilitySourcePreferences(latestRepo.worktreeVisibilitySourcePreferences)
        ?.custom?.[source.source.id] === undefined &&
      effectiveCustomWorktreeSourceVisibility(latestRepo, source.source.id, visibilityDefaults) ===
        effectiveCustomWorktreeSourceVisibility({}, source.source.id, visibilityDefaults)
  }
}
