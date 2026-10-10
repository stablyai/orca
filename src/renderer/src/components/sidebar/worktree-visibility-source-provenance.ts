import { translate } from '@/i18n/i18n'
import type { ExternalWorktreeVisibility, Repo } from '../../../../shared/repo-types'
import type { WorktreeVisibilityDefaults } from '../../../../shared/global-settings-types'
import { effectiveExternalWorktreeVisibility } from '../../../../shared/external-worktree-visibility'
import {
  effectiveDefaultBuiltInWorktreeSourceVisibility,
  effectiveDefaultCustomWorktreeSourceVisibility,
  normalizeCustomWorktreeVisibilitySources,
  normalizeWorktreeVisibilitySourcePreferences
} from '../../../../shared/worktree/visibility-sources'
import type { WorktreeVisibilitySourceRow } from './WorktreeVisibilitySourceList'

export type WorktreeVisibilitySourceProvenance = {
  kind: 'global' | 'project-override' | 'project-source'
  globalVisibility: ExternalWorktreeVisibility
}

/** What this source resolves to for a project that has no opinion of its own. */
export function globalWorktreeVisibilitySourceValue(
  source: WorktreeVisibilitySourceRow,
  visibilityDefaults: WorktreeVisibilityDefaults | undefined
): ExternalWorktreeVisibility {
  if (source.kind === 'built-in') {
    return effectiveDefaultBuiltInWorktreeSourceVisibility(visibilityDefaults, source.id)
  }
  if (source.kind === 'custom') {
    return effectiveDefaultCustomWorktreeSourceVisibility(visibilityDefaults, source.source.id)
  }
  return effectiveExternalWorktreeVisibility({}, false, visibilityDefaults)
}

export function getWorktreeVisibilitySourceProvenance(
  repo: Repo | undefined,
  source: WorktreeVisibilitySourceRow,
  visibilityDefaults: WorktreeVisibilityDefaults,
  repoCustomSourceIds: ReadonlySet<string>
): WorktreeVisibilitySourceProvenance | null {
  if (!repo) {
    return null
  }
  const globalVisibility = globalWorktreeVisibilitySourceValue(source, visibilityDefaults)
  if (source.kind === 'custom' && repoCustomSourceIds.has(source.source.id)) {
    return { kind: 'project-source', globalVisibility }
  }
  const preferences = normalizeWorktreeVisibilitySourcePreferences(
    repo.worktreeVisibilitySourcePreferences
  )
  const overridden =
    source.kind === 'built-in'
      ? preferences?.builtIn?.[source.id] !== undefined ||
        repo.agentWorktreeVisibility !== undefined
      : source.kind === 'custom'
        ? preferences?.custom?.[source.source.id] !== undefined
        : repo.externalWorktreeVisibility !== undefined
  return { kind: overridden ? 'project-override' : 'global', globalVisibility }
}

/** Sources whose value this project inherits from Global Settings, with what each is set to. */
export function listInheritedWorktreeVisibilitySources(
  repo: Repo,
  visibilityDefaults: WorktreeVisibilityDefaults | undefined
): { source: WorktreeVisibilitySourceRow; globalVisibility: ExternalWorktreeVisibility }[] {
  const defaults = visibilityDefaults ?? {}
  const repoCustomSourceIds = new Set(
    normalizeCustomWorktreeVisibilitySources(repo.customWorktreeVisibilitySources)?.map(
      (source) => source.id
    ) ?? []
  )
  const sources: WorktreeVisibilitySourceRow[] = [
    { kind: 'built-in', id: 'claude' },
    { kind: 'built-in', id: 'gsd' },
    ...(normalizeCustomWorktreeVisibilitySources(defaults.customSources) ?? []).map((source) => ({
      kind: 'custom' as const,
      source
    })),
    { kind: 'other' }
  ]

  return sources.flatMap((source) => {
    const provenance = getWorktreeVisibilitySourceProvenance(
      repo,
      source,
      defaults,
      repoCustomSourceIds
    )
    // Why: a source the project added itself has no global setting behind it to override.
    return !provenance || provenance.kind === 'project-source'
      ? []
      : [{ source, globalVisibility: provenance.globalVisibility }]
  })
}

export function worktreeVisibilityValueLabel(visibility: ExternalWorktreeVisibility): string {
  return visibility === 'show'
    ? translate('auto.components.sidebar.WorktreeVisibilitySourceList.show', 'Show')
    : translate('auto.components.sidebar.WorktreeVisibilitySourceList.hide', 'Hide')
}

/**
 * Names the global value a project is ignoring — only where the two genuinely disagree,
 * so an override that happens to match Global Settings stays quiet.
 */
export function getWorktreeVisibilityOverrideNotice(
  provenance: WorktreeVisibilitySourceProvenance | null,
  visibility: ExternalWorktreeVisibility
): string | null {
  if (provenance?.kind !== 'project-override' || provenance.globalVisibility === visibility) {
    return null
  }
  return translate(
    'auto.components.sidebar.WorktreeVisibilitySourceList.overridingGlobal',
    'Overriding global setting: {{value0}}',
    { value0: worktreeVisibilityValueLabel(provenance.globalVisibility) }
  )
}

export function getWorktreeVisibilitySourceNote(
  provenance: WorktreeVisibilitySourceProvenance | null
): string | null {
  return provenance?.kind === 'project-source'
    ? translate(
        'auto.components.sidebar.WorktreeVisibilitySourceList.projectOnly',
        'Added in this project only.'
      )
    : null
}
