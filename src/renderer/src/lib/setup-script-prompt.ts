import { getDefaultRepoHookSettings } from '../../../shared/constants'
import { resolveHookCommandSourcePolicy } from '../../../shared/hook-command-source-policy'
import type { SetupScriptImportCandidate } from '../../../shared/setup-script-imports'
import type { Repo, RepoHookSettings } from '../../../shared/types'
import type { HookCheckResult } from '@/runtime/runtime-hooks-client'

const SETUP_SCRIPT_PROMPT_DISMISSAL_PREFIX = 'generation-v1:'

export type SetupScriptPromptInspection =
  | {
      status: 'ok'
      repoId: string
      hasEffectiveSetup: boolean
      hasSharedHooks: boolean
      candidate: SetupScriptImportCandidate | null
    }
  | {
      status: 'error'
      repoId: string
    }

export async function inspectSetupScriptPromptState({
  repo,
  checkHooks,
  inspectImports
}: {
  repo: Repo
  checkHooks: () => Promise<HookCheckResult>
  inspectImports: () => Promise<SetupScriptImportCandidate[]>
}): Promise<SetupScriptPromptInspection> {
  try {
    const hooksResult = await checkHooks()
    if (hooksResult.status === 'error') {
      return { status: 'error', repoId: repo.id }
    }
    const hasEffectiveSetup = hasEffectiveSetupCommand(repo, hooksResult)
    if (hasEffectiveSetup) {
      return {
        status: 'ok',
        repoId: repo.id,
        hasEffectiveSetup: true,
        hasSharedHooks: hooksResult.hasHooks,
        candidate: null
      }
    }

    const candidates = await inspectImports()
    return {
      status: 'ok',
      repoId: repo.id,
      hasEffectiveSetup: false,
      hasSharedHooks: hooksResult.hasHooks,
      candidate: candidates[0] ?? null
    }
  } catch (error) {
    console.warn('[setup-script-prompt] Failed to inspect setup scripts:', error)
    return { status: 'error', repoId: repo.id }
  }
}

export function hasEffectiveSetupCommand(repo: Repo, hooksResult: HookCheckResult): boolean {
  const localSetup = repo.hookSettings?.scripts?.setup?.trim()
  const sharedSetup = hooksResult.hooks?.scripts?.setup?.trim()
  const rawPolicy = repo.hookSettings?.commandSourcePolicy
  const sourcePolicy = resolveHookCommandSourcePolicy(rawPolicy, {
    hasLocalScript: Boolean(localSetup)
  })

  if (sourcePolicy === 'local-only') {
    return Boolean(localSetup)
  }

  if (sourcePolicy === 'run-both') {
    return Boolean(sharedSetup || localSetup)
  }

  return Boolean(sharedSetup)
}

export function ignoresSharedSetupScripts(repo: Pick<Repo, 'hookSettings'>): boolean {
  const localSetup = repo.hookSettings?.scripts?.setup?.trim()
  return (
    resolveHookCommandSourcePolicy(repo.hookSettings?.commandSourcePolicy, {
      hasLocalScript: Boolean(localSetup)
    }) === 'local-only'
  )
}

export function getSetupScriptPromptDismissalKey(repoId: string): string {
  return `${SETUP_SCRIPT_PROMPT_DISMISSAL_PREFIX}${repoId}`
}

export function isSetupScriptPromptDismissed(
  repoId: string,
  dismissedEntries: readonly string[]
): boolean {
  return dismissedEntries.includes(getSetupScriptPromptDismissalKey(repoId))
}

export function filterSetupScriptPromptDismissalsToValidRepos(
  value: unknown,
  validRepoIds: Set<string>
): string[] {
  if (!Array.isArray(value)) {
    return []
  }

  const next: string[] = []
  for (const entry of value) {
    if (typeof entry !== 'string' || !entry.startsWith(SETUP_SCRIPT_PROMPT_DISMISSAL_PREFIX)) {
      continue
    }
    const repoId = entry.slice(SETUP_SCRIPT_PROMPT_DISMISSAL_PREFIX.length)
    if (validRepoIds.has(repoId) && !next.includes(entry)) {
      next.push(entry)
    }
  }
  return next
}

export function buildImportedHookSettings(
  repo: Repo,
  candidate: SetupScriptImportCandidate,
  hasSharedHooks: boolean
): RepoHookSettings {
  const defaults = getDefaultRepoHookSettings()
  const current = repo.hookSettings
  return {
    ...defaults,
    ...current,
    setupRunPolicy: current?.setupRunPolicy ?? defaults.setupRunPolicy,
    // Why: imported setup commands are stored as local settings. If a shared
    // hook file exists, run-both preserves its archive hook; otherwise local
    // settings need to be authoritative so the imported setup actually runs.
    commandSourcePolicy:
      current?.commandSourcePolicy === 'local-only'
        ? 'local-only'
        : hasSharedHooks
          ? 'run-both'
          : 'local-only',
    scripts: {
      ...defaults.scripts,
      ...current?.scripts,
      setup: candidate.setup,
      archive: candidate.archive ?? current?.scripts?.archive ?? defaults.scripts.archive
    }
  }
}

export function formatCandidateSource(candidate: SetupScriptImportCandidate): string {
  const [primaryFile, ...remainingFiles] = candidate.files
  if (!primaryFile) {
    return candidate.label
  }
  return remainingFiles.length > 0
    ? `${candidate.label} (${primaryFile} +${remainingFiles.length})`
    : `${candidate.label} (${primaryFile})`
}

// Why: card provenance shows the file(s) we matched, not the provider label.
// For a single file we just print its name; for two we join with "and"; for
// more we keep the leading file and summarize the rest as "+N more".
export function formatCandidateProvenance(candidate: SetupScriptImportCandidate): string | null {
  if (candidate.provider === 'package-manager') {
    const lockfile = candidate.files.find((file) => file !== 'package.json')
    if (lockfile) {
      return lockfile
    }
  }
  const [primaryFile, secondaryFile, ...rest] = candidate.files
  if (!primaryFile) {
    return null
  }
  if (!secondaryFile) {
    return primaryFile
  }
  if (rest.length === 0) {
    return `${primaryFile} and ${secondaryFile}`
  }
  return `${primaryFile} +${rest.length + 1} more`
}
