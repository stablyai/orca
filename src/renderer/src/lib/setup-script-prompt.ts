import { getDefaultRepoHookSettings } from '../../../shared/constants'
import { resolveHookCommandSourcePolicy } from '../../../shared/hook-command-source-policy'
import type { SetupScriptImportCandidate } from '../../../shared/setup-script-imports'
import type { RepoHookSettings } from '../../../shared/orca-yaml-hook-types'
import type { Repo } from '../../../shared/repo-types'
import type { HookCheckResult } from '@/runtime/runtime-hooks-client'
import { isRuntimeScopeForbiddenError } from '@/runtime/runtime-rpc-result'
import { hasEffectiveSetupCommand } from './setup-script-status'

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
  // Mobile-scope forbiddance is permanent; the global banner explains it, and retry-on-focus would repeatedly call hooksCheck.
  | {
      status: 'forbidden'
      repoId: string
    }
  // The repo's WSL distro is stopped: nothing to say until it runs, and a Retry could not succeed.
  | {
      status: 'distro-stopped'
      repoId: string
    }

/**
 * States the card shows nothing for: mobile-scope forbiddance (the global banner explains it) and a
 * stopped WSL distro (focus re-inspects, so the card returns once it runs; a Retry could not succeed).
 */
export function isSilentSetupScriptPromptState(state: { status: string }): boolean {
  return state.status === 'forbidden' || state.status === 'distro-stopped'
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
      return hooksResult.unavailable === 'wsl-distro-stopped'
        ? { status: 'distro-stopped', repoId: repo.id }
        : { status: 'error', repoId: repo.id }
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
    if (isRuntimeScopeForbiddenError(error)) {
      return { status: 'forbidden', repoId: repo.id }
    }
    console.warn('[setup-script-prompt] Failed to inspect setup scripts:', error)
    return { status: 'error', repoId: repo.id }
  }
}

export function ignoresSharedSetupScripts(repo: Pick<Repo, 'hookSettings'>): boolean {
  const localSetup = repo.hookSettings?.scripts?.setup?.trim()
  return (
    resolveHookCommandSourcePolicy(repo.hookSettings?.commandSourcePolicy, {
      hasLocalScript: Boolean(localSetup)
    }) === 'local-only'
  )
}

export function getSetupScriptPromptDismissalKey(repoHostIdentity: string): string {
  return `${SETUP_SCRIPT_PROMPT_DISMISSAL_PREFIX}${repoHostIdentity}`
}

/** The repo of a dismissal key, host-qualified (`<host>\0<repoId>`) or legacy bare. */
export function getSetupScriptPromptDismissalRepoId(entry: string): string {
  const identity = entry.slice(SETUP_SCRIPT_PROMPT_DISMISSAL_PREFIX.length)
  return identity.slice(identity.indexOf('\0') + 1)
}

export function isSetupScriptPromptDismissed(
  repoHostIdentity: string,
  dismissedEntries: readonly string[]
): boolean {
  return dismissedEntries.includes(getSetupScriptPromptDismissalKey(repoHostIdentity))
}

function isUnchangedDismissalList(
  value: unknown,
  next: readonly string[]
): value is readonly string[] {
  return (
    Array.isArray(value) &&
    value.length === next.length &&
    value.every((entry, index) => entry === next[index])
  )
}

export function filterSetupScriptPromptDismissalsToValidRepos(
  value: unknown,
  validRepoHostIdentities: Set<string>
): readonly string[] {
  const unambiguousIdentityByRepoId = new Map<string, string | null>()
  for (const identity of validRepoHostIdentities) {
    const separatorIndex = identity.indexOf('\0')
    const repoId = separatorIndex !== -1 ? identity.slice(separatorIndex + 1) : identity
    unambiguousIdentityByRepoId.set(
      repoId,
      unambiguousIdentityByRepoId.has(repoId) ? null : identity
    )
  }

  const next: string[] = []
  for (const entry of sanitizeSetupScriptPromptDismissals(value)) {
    const repoHostIdentity = entry.slice(SETUP_SCRIPT_PROMPT_DISMISSAL_PREFIX.length)
    const validIdentity = validRepoHostIdentities.has(repoHostIdentity)
      ? repoHostIdentity
      : unambiguousIdentityByRepoId.get(repoHostIdentity)
    if (validIdentity) {
      const validEntry = getSetupScriptPromptDismissalKey(validIdentity)
      if (!next.includes(validEntry)) {
        next.push(validEntry)
      }
    }
  }
  // No-op pruning must return the original array for Object.is subscribers on every catalog refresh; sanitize always allocates, even for valid/empty input.
  if (isUnchangedDismissalList(value, next)) {
    return value
  }
  return next
}

export function sanitizeSetupScriptPromptDismissals(value: unknown): readonly string[] {
  if (!Array.isArray(value)) {
    return []
  }

  const next: string[] = []
  for (const entry of value) {
    if (typeof entry !== 'string' || !entry.startsWith(SETUP_SCRIPT_PROMPT_DISMISSAL_PREFIX)) {
      continue
    }
    if (!next.includes(entry)) {
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
    // Imported local commands need authority unless a shared hook exists, in which case run-both preserves it.
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

// Show matched filenames as provenance: one name, two with and, or first +N more; never substitute provider labels.
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
