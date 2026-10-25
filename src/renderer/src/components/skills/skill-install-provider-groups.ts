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
  /** Canonical-root consumers receive every install and have no per-agent checkbox. */
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
  // Keep absent agents available for future installs, below currently installed agents.
  const installed = new Set(detectedAgents)
  return {
    canonical,
    selectable: [
      ...selectable.filter((choice) => installed.has(choice.provider.id)),
      ...selectable.filter((choice) => !installed.has(choice.provider.id))
    ]
  }
}

/** Default to detected agents; unknown detection retains the legacy all-agent install behavior. */
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
