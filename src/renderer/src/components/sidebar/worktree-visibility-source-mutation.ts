import type { ExternalWorktreeVisibility, Repo } from '../../../../shared/repo-types'
import type { WorktreeVisibilityDefaults } from '../../../../shared/global-settings-types'
import {
  effectiveExternalWorktreeVisibility,
  isLegacyRepoForExternalWorktreeVisibility
} from '../../../../shared/external-worktree-visibility'
import {
  effectiveBuiltInWorktreeSourceVisibility,
  effectiveCustomWorktreeSourceVisibility
} from '../../../../shared/worktree/visibility-sources'
import { buildWorktreeSourcePreferenceUpdate } from '../../../../shared/worktree/visibility-source-preferences'
import type { RepoUpdate } from '@/store/slices/repos'
import type { WorktreeVisibilitySourceRow } from './WorktreeVisibilitySourceList'

export type WorktreeVisibilitySourceMutation = {
  updates: RepoUpdate
  isAccepted: (latestRepo: Repo) => boolean
}

/** Pins this project's own visibility for a source, overriding whatever Global Settings holds. */
export function createWorktreeVisibilitySourceMutation(
  repo: Repo,
  source: WorktreeVisibilitySourceRow,
  visibility: ExternalWorktreeVisibility,
  visibilityDefaults: WorktreeVisibilityDefaults | undefined
): WorktreeVisibilitySourceMutation {
  if (source.kind === 'other') {
    return {
      updates: {
        externalWorktreeVisibility: visibility,
        // Re-showing clears the suppression so discovery can surface the source again.
        ...(visibility === 'show' ? { externalWorktreeDiscoverySuppressedAt: null } : {})
      },
      isAccepted: (latestRepo) =>
        effectiveExternalWorktreeVisibility(
          latestRepo,
          isLegacyRepoForExternalWorktreeVisibility(latestRepo),
          visibilityDefaults
        ) === visibility
    }
  }
  const match =
    source.kind === 'built-in'
      ? ({ kind: 'built-in', id: source.id } as const)
      : ({ kind: 'custom', id: source.source.id } as const)
  return {
    updates: {
      worktreeVisibilitySourcePreferences: buildWorktreeSourcePreferenceUpdate(
        repo,
        match,
        visibility
      )
    },
    isAccepted: (latestRepo) =>
      source.kind === 'built-in'
        ? effectiveBuiltInWorktreeSourceVisibility(latestRepo, source.id, visibilityDefaults) ===
          visibility
        : effectiveCustomWorktreeSourceVisibility(
            latestRepo,
            source.source.id,
            visibilityDefaults
          ) === visibility
  }
}
