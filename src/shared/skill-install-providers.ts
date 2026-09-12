import type { SkillDiscoverySource } from './skills'

/**
 * Agents Orca can place an installed skill for.
 *
 * `null` segments mean the agent reads the canonical `.agents/skills` root at
 * that scope, so it needs no placement of its own. Ids match the detection ids
 * in `tui-agent-config.ts` so a detected agent maps straight to a destination.
 */
export type SkillInstallProviderId =
  | 'codex'
  | 'claude'
  | 'cursor'
  | 'gemini'
  | 'droid'
  | 'continue'
  | 'trae'
  | 'grok'
  | 'aug'

export type SkillInstallProviderDefinition = {
  id: SkillInstallProviderId
  displayName: string
  globalSegments: readonly string[] | null
  workspaceSegments: readonly string[] | null
}

export const SKILL_INSTALL_PROVIDERS: readonly SkillInstallProviderDefinition[] = [
  // Why: Codex reads the canonical .agents/skills root at both scopes.
  {
    id: 'codex',
    displayName: 'Codex',
    globalSegments: null,
    workspaceSegments: null
  },
  {
    id: 'claude',
    displayName: 'Claude Code',
    globalSegments: ['.claude', 'skills'],
    workspaceSegments: ['.claude', 'skills']
  },
  // Why: Cursor and Gemini read the canonical root inside a project but keep
  // their own home directory, so they only need a placement at global scope.
  {
    id: 'cursor',
    displayName: 'Cursor',
    globalSegments: ['.cursor', 'skills'],
    workspaceSegments: null
  },
  {
    id: 'gemini',
    displayName: 'Gemini CLI',
    globalSegments: ['.gemini', 'skills'],
    workspaceSegments: null
  },
  {
    id: 'droid',
    displayName: 'Droid',
    globalSegments: ['.factory', 'skills'],
    workspaceSegments: ['.factory', 'skills']
  },
  {
    id: 'continue',
    displayName: 'Continue',
    globalSegments: ['.continue', 'skills'],
    workspaceSegments: ['.continue', 'skills']
  },
  {
    id: 'trae',
    displayName: 'Trae',
    globalSegments: ['.trae-cn', 'skills'],
    workspaceSegments: ['.trae', 'skills']
  },
  {
    id: 'grok',
    displayName: 'Grok',
    globalSegments: ['.grok', 'skills'],
    workspaceSegments: ['.grok', 'skills']
  },
  {
    id: 'aug',
    displayName: 'Augment',
    globalSegments: ['.augment', 'skills'],
    workspaceSegments: ['.augment', 'skills']
  }
]

const PROVIDERS_BY_ID = new Map(SKILL_INSTALL_PROVIDERS.map((provider) => [provider.id, provider]))

export function isSkillInstallProviderId(value: string): value is SkillInstallProviderId {
  return PROVIDERS_BY_ID.has(value as SkillInstallProviderId)
}

export function skillInstallProvider(
  id: SkillInstallProviderId
): SkillInstallProviderDefinition | undefined {
  return PROVIDERS_BY_ID.get(id)
}

const SKILL_INSTALL_PROVIDER_ALIASES: Readonly<Record<string, SkillInstallProviderId>> = {
  'claude-agent-teams': 'claude',
  openclaude: 'claude'
}

/** Resolve a detected agent to the provider registry entry that owns its roots. */
export function skillInstallProviderIdForAgent(value: string): SkillInstallProviderId | null {
  if (isSkillInstallProviderId(value)) {
    return value
  }
  return SKILL_INSTALL_PROVIDER_ALIASES[value] ?? null
}

/**
 * Whether a discovered source is readable by an agent at its scan scope.
 * Shared canonical roots are only visible where the registry says the provider
 * reads that scope; owned roots remain limited to their owner (and aliases).
 */
export function isSkillSourceVisibleToAgent(
  agent: string,
  source: Pick<SkillDiscoverySource, 'owner' | 'sourceKind'>
): boolean {
  const providerId = skillInstallProviderIdForAgent(agent)
  const sourceOwner = source.owner
  if (sourceOwner !== null) {
    return sourceOwner === agent || sourceOwner === providerId
  }

  const provider = providerId ? skillInstallProvider(providerId) : undefined
  if (!provider) {
    return false
  }
  if (source.sourceKind === 'home') {
    return provider.globalSegments === null
  }
  if (source.sourceKind === 'repo') {
    return provider.workspaceSegments === null
  }
  return false
}

/** Detected agents Orca can actually place skills for, in registry order. */
export function installableSkillProviders(
  detectedProviders: readonly string[]
): SkillInstallProviderDefinition[] {
  const detected = new Set(detectedProviders)
  return SKILL_INSTALL_PROVIDERS.filter((provider) => detected.has(provider.id))
}

/**
 * An explicit choice is authoritative, including agents the target may install
 * later. Removal passes no choice so it can clean every previously used root.
 */
export function selectedOrDetectedSkillProviders(
  detectedProviders: readonly string[],
  selectedProviders: readonly string[] | undefined
): readonly string[] {
  return selectedProviders ?? detectedProviders
}
