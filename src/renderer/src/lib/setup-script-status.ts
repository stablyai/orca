import { resolveHookCommandSourcePolicy } from '../../../shared/hook-command-source-policy'
import type { Repo, RepoHookSettings } from '../../../shared/types'
import type { HookCheckResult } from '@/runtime/runtime-hooks-client'

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

export function buildImportedSetupHookSettings(
  repo: Repo,
  setup: string,
  archive: string | undefined,
  hasSharedHooks: boolean,
  defaults: RepoHookSettings
): RepoHookSettings {
  const current = repo.hookSettings
  return {
    ...defaults,
    ...current,
    setupRunPolicy: current?.setupRunPolicy ?? defaults.setupRunPolicy,
    // Why: imported setup commands are stored as local settings. If a shared
    // hook file exists, run-both preserves its archive hook; otherwise local
    // settings need to be authoritative so the imported setup actually runs.
    commandSourcePolicy: hasSharedHooks ? 'run-both' : 'local-only',
    scripts: {
      ...defaults.scripts,
      ...current?.scripts,
      setup,
      archive: archive ?? current?.scripts?.archive ?? defaults.scripts.archive
    }
  }
}
