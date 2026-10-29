import { resolveHookCommandSourcePolicy } from './hook-command-source-policy'
import type { OrcaHooks, SetupRunPolicy } from './orca-yaml-hook-types'

export type SetupConfig = {
  source: 'yaml' | 'local' | 'both'
  command: string
  kind: 'setup' | 'default-tabs' | 'setup-and-default-tabs'
}

function getDefaultTabCommandEntries(yamlHooks: OrcaHooks | null): string[] {
  return (yamlHooks?.defaultTabs ?? [])
    .map((tab, index) => {
      const command = tab.command?.trim()
      if (!command) {
        return null
      }
      const label = tab.title ? ` ${tab.title}` : ''
      return `# defaultTabs[${index + 1}]${label}\n${command}`
    })
    .filter((entry): entry is string => entry !== null)
}

function joinSetupTrustContent(yamlSetup: string | undefined, defaultTabEntries: string[]): string {
  return [yamlSetup, ...defaultTabEntries].filter(Boolean).join('\n\n')
}

/** The orca.yaml commands a setup trust approval covers: setup plus every defaultTabs command. */
export function getSetupTrustContent(yamlHooks: OrcaHooks | null): string {
  return joinSetupTrustContent(
    yamlHooks?.scripts?.setup?.trim(),
    getDefaultTabCommandEntries(yamlHooks)
  )
}

function getSetupConfigKind(
  hasSetup: boolean,
  hasDefaultTabCommands: boolean
): SetupConfig['kind'] {
  if (hasSetup && hasDefaultTabCommands) {
    return 'setup-and-default-tabs'
  }
  if (hasDefaultTabCommands) {
    return 'default-tabs'
  }
  return 'setup'
}

export function getSetupConfig(
  repo:
    | {
        hookSettings?: {
          commandSourcePolicy?: unknown
          scripts?: { setup?: string }
        }
      }
    | undefined,
  yamlHooks: OrcaHooks | null
): SetupConfig | null {
  const localSetup = repo?.hookSettings?.scripts?.setup?.trim()
  const sourcePolicy = resolveHookCommandSourcePolicy(repo?.hookSettings?.commandSourcePolicy, {
    hasLocalScript: Boolean(localSetup)
  })

  if (sourcePolicy === 'local-only') {
    return localSetup ? { source: 'local', command: localSetup, kind: 'setup' } : null
  }

  const yamlSetup = yamlHooks?.scripts?.setup?.trim()
  const defaultTabEntries = getDefaultTabCommandEntries(yamlHooks)
  const hasDefaultTabCommands = defaultTabEntries.length > 0
  const yamlCommand = joinSetupTrustContent(yamlSetup, defaultTabEntries)
  if (sourcePolicy === 'run-both' && localSetup) {
    // Why: the host still runs the local script here, so the create must still ask about it.
    return yamlCommand
      ? {
          source: 'both',
          command: `${yamlCommand}\n\n${localSetup}`,
          kind: getSetupConfigKind(true, hasDefaultTabCommands)
        }
      : { source: 'local', command: localSetup, kind: 'setup' }
  }

  if (yamlCommand) {
    return {
      source: 'yaml',
      command: yamlCommand,
      kind: getSetupConfigKind(Boolean(yamlSetup), hasDefaultTabCommands)
    }
  }
  return null
}

/** Null means no preset decision: nothing to run, or the repo asks every create. */
export function getDefaultSetupDecision(
  hasSetupConfig: boolean,
  setupPolicy: SetupRunPolicy
): 'run' | 'skip' | null {
  if (!hasSetupConfig || setupPolicy === 'ask') {
    return null
  }
  return setupPolicy === 'run-by-default' ? 'run' : 'skip'
}
