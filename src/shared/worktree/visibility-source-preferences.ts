import type {
  ExternalWorktreeVisibility,
  Repo,
  WorktreeVisibilitySourcePreferences
} from '../repo-types'
import type { WorktreeVisibilityDefaults } from '../global-settings-types'
import {
  normalizeWorktreeVisibilitySourcePreferences,
  type WorktreeVisibilitySourceMatch
} from './visibility-sources'

function legacyBuiltInPreferences(
  repo: Pick<Repo, 'agentWorktreeVisibility'>
): WorktreeVisibilitySourcePreferences['builtIn'] {
  return repo.agentWorktreeVisibility
    ? { claude: repo.agentWorktreeVisibility, gsd: repo.agentWorktreeVisibility }
    : {}
}

function preferenceResult(
  builtIn: NonNullable<WorktreeVisibilitySourcePreferences['builtIn']>,
  custom: NonNullable<WorktreeVisibilitySourcePreferences['custom']>
): WorktreeVisibilitySourcePreferences {
  return {
    ...(Object.keys(builtIn).length > 0 ? { builtIn } : {}),
    ...(Object.keys(custom).length > 0 ? { custom } : {})
  }
}

export function buildWorktreeSourcePreferenceUpdate(
  repo: Pick<Repo, 'agentWorktreeVisibility' | 'worktreeVisibilitySourcePreferences'>,
  source: WorktreeVisibilitySourceMatch,
  visibility: ExternalWorktreeVisibility
): WorktreeVisibilitySourcePreferences {
  const current = normalizeWorktreeVisibilitySourcePreferences(
    repo.worktreeVisibilitySourcePreferences
  )
  const builtIn = { ...legacyBuiltInPreferences(repo), ...current?.builtIn }
  const custom = { ...current?.custom }
  if (source.kind === 'built-in') {
    builtIn[source.id] = visibility
  } else {
    custom[source.id] = visibility
  }
  return preferenceResult(builtIn, custom)
}

export function removeCustomWorktreeSourcePreference(
  repo: Pick<Repo, 'agentWorktreeVisibility' | 'worktreeVisibilitySourcePreferences'>,
  sourceId: string
): WorktreeVisibilitySourcePreferences {
  const current = normalizeWorktreeVisibilitySourcePreferences(
    repo.worktreeVisibilitySourcePreferences
  )
  const custom = { ...current?.custom }
  delete custom[sourceId]
  return preferenceResult({ ...legacyBuiltInPreferences(repo), ...current?.builtIn }, custom)
}

export function removeBuiltInWorktreeSourcePreference(
  repo: Pick<Repo, 'agentWorktreeVisibility' | 'worktreeVisibilitySourcePreferences'>,
  sourceId: keyof NonNullable<WorktreeVisibilitySourcePreferences['builtIn']>
): WorktreeVisibilitySourcePreferences {
  const current = normalizeWorktreeVisibilitySourcePreferences(
    repo.worktreeVisibilitySourcePreferences
  )
  const builtIn = { ...legacyBuiltInPreferences(repo), ...current?.builtIn }
  delete builtIn[sourceId]
  return preferenceResult(builtIn, { ...current?.custom })
}

export function buildDefaultWorktreeSourcePreferenceUpdate(
  defaults: WorktreeVisibilityDefaults,
  source: WorktreeVisibilitySourceMatch,
  visibility: ExternalWorktreeVisibility
): WorktreeVisibilitySourcePreferences {
  const current = normalizeWorktreeVisibilitySourcePreferences(defaults.sourcePreferences)
  const builtIn = { ...current?.builtIn }
  const custom = { ...current?.custom }
  if (source.kind === 'built-in') {
    builtIn[source.id] = visibility
  } else {
    custom[source.id] = visibility
  }
  return preferenceResult(builtIn, custom)
}

export function removeDefaultCustomWorktreeSourcePreference(
  defaults: WorktreeVisibilityDefaults,
  sourceId: string
): WorktreeVisibilitySourcePreferences {
  const current = normalizeWorktreeVisibilitySourcePreferences(defaults.sourcePreferences)
  const custom = { ...current?.custom }
  delete custom[sourceId]
  return preferenceResult({ ...current?.builtIn }, custom)
}
