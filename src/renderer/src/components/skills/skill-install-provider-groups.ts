import {
  SKILL_INSTALL_PROVIDERS,
  type SkillInstallProviderDefinition,
  type SkillInstallProviderId
} from '../../../../shared/skill-install-providers'

export type SkillInstallProviderChoice = {
  provider: SkillInstallProviderDefinition
  /** Where this agent reads skills from, relative to the chosen scope. */
  directory: string
}

export type SkillInstallProviderGroups = {
  /** Agents that read the canonical `.agents/skills` root, so every install
   *  reaches them and there is nothing to choose. */
  canonical: SkillInstallProviderDefinition[]
  selectable: SkillInstallProviderChoice[]
}

export function skillProviderDirectoryLabel(
  segments: readonly string[],
  scope: 'global' | 'workspace'
): string {
  const joined = segments.join('/')
  return scope === 'global' ? `~/${joined}` : joined
}

export function groupSkillInstallProviders(
  scope: 'global' | 'workspace',
  detectedAgents: readonly string[] | null = null
): SkillInstallProviderGroups {
  const canonical: SkillInstallProviderDefinition[] = []
  const selectable: SkillInstallProviderChoice[] = []
  for (const provider of SKILL_INSTALL_PROVIDERS) {
    const segments = scope === 'global' ? provider.globalSegments : provider.workspaceSegments
    if (segments) {
      selectable.push({ provider, directory: skillProviderDirectoryLabel(segments, scope) })
    } else {
      canonical.push(provider)
    }
  }
  if (!detectedAgents) {
    return { canonical, selectable }
  }
  // Why: agents the machine does not have are still offered — you may install
  // one later — but they belong under the ones the choice actually affects.
  const installed = new Set(detectedAgents)
  return {
    canonical,
    selectable: [
      ...selectable.filter((choice) => installed.has(choice.provider.id)),
      ...selectable.filter((choice) => !installed.has(choice.provider.id))
    ]
  }
}

/**
 * Starts with the agents the target machine actually has, so the common case is
 * one click. A null detection (a runtime that cannot be probed from here) falls
 * back to every agent, which is what installing did before the picker existed.
 */
export function defaultSelectedSkillProviders(
  detectedAgents: readonly string[] | null
): Set<SkillInstallProviderId> {
  const ids = SKILL_INSTALL_PROVIDERS.map((provider) => provider.id)
  if (!detectedAgents) {
    return new Set(ids)
  }
  const detected = new Set(detectedAgents)
  return new Set(ids.filter((id) => detected.has(id)))
}

export function toggledSkillProviderSelection(
  current: ReadonlySet<SkillInstallProviderId>,
  provider: SkillInstallProviderId,
  selected: boolean
): Set<SkillInstallProviderId> {
  const next = new Set(current)
  if (selected) {
    next.add(provider)
  } else {
    next.delete(provider)
  }
  return next
}
