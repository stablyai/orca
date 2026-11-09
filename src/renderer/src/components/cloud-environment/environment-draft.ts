import { repoKey } from './cloud-environment-copy'
import type {
  EnvironmentBuildView,
  EnvironmentDraft,
  EnvironmentView
} from './cloud-environment-types'

export const DEFAULT_ENVIRONMENT_NAME = 'Default'

export function draftFromEnvironment(environment: EnvironmentView): EnvironmentDraft {
  return {
    name: environment.name,
    repos: environment.repos.map((repo) => ({
      url: repo.url,
      defaultBranch: repo.defaultBranch
    })),
    installScript: environment.installScript,
    envVarNames: [...environment.envVarNames],
    machineSize: environment.machineSize
  }
}

export function emptyDraft(repoSlugs: readonly string[] = []): EnvironmentDraft {
  return {
    name: DEFAULT_ENVIRONMENT_NAME,
    repos: repoSlugs.map((url) => ({ url, defaultBranch: null })),
    installScript: '',
    envVarNames: [],
    machineSize: 'standard'
  }
}

function normalizedBranch(branch: string | null): string | null {
  const trimmed = branch?.trim() ?? ''
  return trimmed === '' ? null : trimmed
}

export function draftsEqual(a: EnvironmentDraft, b: EnvironmentDraft): boolean {
  return (
    a.name.trim() === b.name.trim() &&
    a.installScript === b.installScript &&
    a.machineSize === b.machineSize &&
    a.envVarNames.length === b.envVarNames.length &&
    a.envVarNames.every((name, index) => name === b.envVarNames[index]) &&
    a.repos.length === b.repos.length &&
    a.repos.every(
      (repo, index) =>
        repoKey(repo.url) === repoKey(b.repos[index].url) &&
        normalizedBranch(repo.defaultBranch) === normalizedBranch(b.repos[index].defaultBranch)
    )
  )
}

/** Only the fields that changed, so a concurrent edit to another field is not clobbered. */
export function draftPatch(
  base: EnvironmentDraft,
  draft: EnvironmentDraft
): Partial<EnvironmentDraft> {
  const patch: Partial<EnvironmentDraft> = {}
  if (base.name.trim() !== draft.name.trim()) {
    patch.name = draft.name.trim()
  }
  if (base.installScript !== draft.installScript) {
    patch.installScript = draft.installScript
  }
  if (base.machineSize !== draft.machineSize) {
    patch.machineSize = draft.machineSize
  }
  if (
    base.envVarNames.length !== draft.envVarNames.length ||
    base.envVarNames.some((name, index) => name !== draft.envVarNames[index])
  ) {
    patch.envVarNames = draft.envVarNames
  }
  const reposChanged =
    base.repos.length !== draft.repos.length ||
    base.repos.some(
      (repo, index) =>
        repoKey(repo.url) !== repoKey(draft.repos[index].url) ||
        normalizedBranch(repo.defaultBranch) !== normalizedBranch(draft.repos[index].defaultBranch)
    )
  if (reposChanged) {
    patch.repos = draft.repos.map((repo) => ({
      url: repo.url,
      defaultBranch: normalizedBranch(repo.defaultBranch)
    }))
  }
  return patch
}

/** Union of names, existing order first; imports never drop a name the user already has. */
export function mergeEnvVarNames(
  existing: readonly string[],
  incoming: readonly string[]
): string[] {
  const merged = [...existing]
  for (const name of incoming) {
    if (!merged.includes(name)) {
      merged.push(name)
    }
  }
  return merged
}

export type DiffLine = { kind: 'same' | 'add' | 'remove'; text: string }

/** Small LCS line diff for the import review (scripts are short; capped to keep it cheap). */
export function lineDiff(before: string, after: string, maxLines = 600): DiffLine[] {
  const a = before === '' ? [] : before.split('\n')
  const b = after === '' ? [] : after.split('\n')
  if (a.length > maxLines || b.length > maxLines) {
    return [
      ...a.map((text): DiffLine => ({ kind: 'remove', text })),
      ...b.map((text): DiffLine => ({ kind: 'add', text }))
    ]
  }
  const table: number[][] = Array.from({ length: a.length + 1 }, () =>
    Array.from({ length: b.length + 1 }, () => 0)
  )
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      table[i][j] =
        a[i] === b[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1])
    }
  }
  const out: DiffLine[] = []
  let i = 0
  let j = 0
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      out.push({ kind: 'same', text: a[i] })
      i += 1
      j += 1
    } else if (table[i + 1][j] >= table[i][j + 1]) {
      out.push({ kind: 'remove', text: a[i] })
      i += 1
    } else {
      out.push({ kind: 'add', text: b[j] })
      j += 1
    }
  }
  for (; i < a.length; i += 1) {
    out.push({ kind: 'remove', text: a[i] })
  }
  for (; j < b.length; j += 1) {
    out.push({ kind: 'add', text: b[j] })
  }
  return out
}

/** Insert or replace a build (newest first); a build that just became active demotes the others. */
export function upsertBuild(
  builds: readonly EnvironmentBuildView[],
  build: EnvironmentBuildView
): EnvironmentBuildView[] {
  const index = builds.findIndex((entry) => entry.id === build.id)
  const next =
    index === -1
      ? [build, ...builds].sort((a, b) => b.number - a.number)
      : builds.map((entry, i) => (i === index ? build : entry))
  return build.active
    ? next.map((entry) => (entry.id === build.id ? entry : { ...entry, active: false }))
    : next
}

export const ENV_VAR_NAME_PATTERN = /^[A-Z_][A-Z0-9_]{0,127}$/
export const MAX_ENV_VAR_NAMES = 100
export const MAX_INSTALL_SCRIPT_CHARS = 20000

/** Splits pasted text (`FOO BAR,BAZ` or `FOO=1\nBAR=2`) into candidate names. */
export function parseEnvVarNames(input: string): {
  valid: string[]
  invalid: string[]
} {
  const valid: string[] = []
  const invalid: string[] = []
  const withoutExports = input.replace(/(^|\n)\s*export\s+/g, '$1')
  for (const raw of withoutExports.split(/[\s,;]+/)) {
    const name = raw.split('=')[0].trim()
    if (!name) {
      continue
    }
    const upper = name.toUpperCase()
    if (ENV_VAR_NAME_PATTERN.test(upper)) {
      if (!valid.includes(upper)) {
        valid.push(upper)
      }
    } else {
      invalid.push(name)
    }
  }
  return { valid, invalid }
}
