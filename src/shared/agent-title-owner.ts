import { rebrandPiStateTitle } from './pi-state-title-marker'
import { detectAgentStatusFromTitle, getAgentLabel } from './agent-detection'
import { STRONG_IDLE_KEYWORDS_RE } from './agent-title-core'
import type { AgentStatusEntry, AgentType } from './agent-status-types'
import {
  getSyntheticAgentTitleProfile,
  SYNTHETIC_AGENT_TITLE_PROFILES,
  type SyntheticAgentTitleProfile
} from './synthetic-agent-title'
import { isLegacyPiCompatibleTitle } from './pi-compatible-synthetic-title'
import { getWrapperTitleSegments } from './terminal-title-wrapper-segments'

/** The π brand a Pi/OMP title leads with; the owner's label replaces it in place. */
const LEGACY_PI_BRAND = 'π'

type TitleProfileMatch = {
  profile: SyntheticAgentTitleProfile
  sourceTitle: string
}

type TitleLabelProfileMatch = Pick<TitleProfileMatch, 'profile'>

export type CompatibleAgentOwnerOptions = {
  /** Whether the owner comes from explicit launch intent. */
  ownerIsLaunch?: boolean
}

function getProfileForTitleLabel(label: string | null): TitleLabelProfileMatch | null {
  if (!label) {
    return null
  }
  const normalizedLabel = label.trim().toLowerCase()
  for (const profile of Object.values(SYNTHETIC_AGENT_TITLE_PROFILES)) {
    if (profile.workingLabel.toLowerCase() === normalizedLabel) {
      return { profile }
    }
  }
  return null
}

function getProfileForTitle(title: string): TitleProfileMatch | null {
  // Why each segment: a wrapper prefix must not hide the inner compatible agent identity.
  const candidates = getWrapperTitleSegments(title)
  let fallback: TitleProfileMatch | null = null
  for (const candidate of candidates) {
    const labelProfile = getProfileForTitleLabel(getAgentLabel(candidate))
    const legacyProfile = isLegacyPiCompatibleTitle(candidate)
      ? getProfileForTitleLabel('Pi')
      : null
    const candidateProfile = labelProfile ?? legacyProfile
    if (!candidateProfile) {
      continue
    }
    const match = { ...candidateProfile, sourceTitle: candidate }
    if (candidateProfile.profile.titleIdentityGroup) {
      return match
    }
    fallback ??= match
  }
  return fallback
}

/** Unknown-launch remote sessions need foreground ownership before emitting titles whose identity can be re-owned. */
export function hasCompatibleAgentTitleIdentity(title: string): boolean {
  return Boolean(getProfileForTitle(title)?.profile.titleIdentityGroup)
}

function getSourceTitleStatus(title: string): 'working' | 'permission' | 'idle' | null {
  const detectedStatus = detectAgentStatusFromTitle(title)
  if (detectedStatus) {
    return detectedStatus
  }
  if (isLegacyPiCompatibleTitle(title)) {
    return 'idle'
  }
  return null
}

function hasPermissionSuffix(title: string, sourceProfile: SyntheticAgentTitleProfile): boolean {
  const normalizedTitle = title.trim().toLowerCase()
  return (
    normalizedTitle === sourceProfile.permissionLabel.toLowerCase() ||
    normalizedTitle.includes('action required') ||
    normalizedTitle.includes('permission') ||
    normalizedTitle.includes('waiting')
  )
}

function hasIdleSuffix(title: string, sourceProfile: SyntheticAgentTitleProfile): boolean {
  const normalizedTitle = title.trim().toLowerCase()
  return (
    normalizedTitle === sourceProfile.idleLabel.toLowerCase() || STRONG_IDLE_KEYWORDS_RE.test(title)
  )
}

/** Remote OMP may report Pi live status; launch ownership preserves the selected agent. */
export function resolveCompatibleAgentTypeForOwner(
  incomingAgentType: AgentType | null | undefined,
  ownerAgentType: AgentType | null | undefined,
  _options?: CompatibleAgentOwnerOptions
): AgentType | undefined {
  if (!incomingAgentType) {
    return undefined
  }
  const incomingProfile = getSyntheticAgentTitleProfile(incomingAgentType)
  const ownerProfile = getSyntheticAgentTitleProfile(ownerAgentType)
  if (
    !incomingProfile?.titleIdentityGroup ||
    !ownerProfile?.titleIdentityGroup ||
    incomingProfile.titleIdentityGroup !== ownerProfile.titleIdentityGroup
  ) {
    return incomingAgentType
  }
  return ownerAgentType as AgentType
}

/** Wrapped Pi harness frames retain the stable launch-owner profile during work. */
export function normalizeCompatibleAgentTitleForOwner(
  title: string,
  ownerAgentType: AgentType | null | undefined,
  _options?: CompatibleAgentOwnerOptions
): string {
  const ownerProfile = getSyntheticAgentTitleProfile(ownerAgentType)
  if (!ownerProfile?.titleIdentityGroup) {
    return title
  }
  const source = getProfileForTitle(title)
  if (
    !source?.profile.titleIdentityGroup ||
    source.profile.titleIdentityGroup !== ownerProfile.titleIdentityGroup
  ) {
    return title
  }
  const stateTitle = rebrandPiStateTitle(title, ownerProfile.workingLabel)
  if (stateTitle !== null) {
    return stateTitle
  }
  // Replace only the π brand with launch ownership; retain the agent's session/cwd instead of collapsing its semantic title (#16093).
  if (isLegacyPiCompatibleTitle(source.sourceTitle)) {
    // Replace within the matched segment so multiplexer prefixes retain their brand; a prefix parsing as a π title remains an ambiguous match.
    const ownedSegment = source.sourceTitle.replace(LEGACY_PI_BRAND, ownerProfile.workingLabel)
    const segmentAt = title.lastIndexOf(source.sourceTitle)
    return segmentAt === -1 ? ownedSegment : title.slice(0, segmentAt) + ownedSegment
  }
  const sourceStatus = getSourceTitleStatus(source.sourceTitle)
  if (sourceStatus === 'working') {
    return `\u280b ${ownerProfile.workingLabel}`
  }
  if (sourceStatus === 'permission') {
    return ownerProfile.permissionLabel
  }
  if (sourceStatus === 'idle') {
    return ownerProfile.idleLabel
  }
  if (hasPermissionSuffix(source.sourceTitle, source.profile)) {
    return ownerProfile.permissionLabel
  }
  if (hasIdleSuffix(source.sourceTitle, source.profile)) {
    return ownerProfile.idleLabel
  }
  return ownerProfile.workingLabel
}

/** Keep mirrored owner/title aligned so later snapshots cannot repaint the tab under its wrapper agent. */
export function normalizeCompatibleAgentStatusEntryForOwner(
  entry: AgentStatusEntry,
  ownerAgentType: AgentType | null | undefined,
  options?: CompatibleAgentOwnerOptions
): AgentStatusEntry {
  const agentType = resolveCompatibleAgentTypeForOwner(entry.agentType, ownerAgentType, options)
  const terminalTitle = entry.terminalTitle
    ? normalizeCompatibleAgentTitleForOwner(
        entry.terminalTitle,
        agentType ?? ownerAgentType,
        options
      )
    : entry.terminalTitle
  if (agentType === entry.agentType && terminalTitle === entry.terminalTitle) {
    return entry
  }
  return {
    ...entry,
    ...(agentType ? { agentType } : {}),
    ...(terminalTitle ? { terminalTitle } : {})
  }
}

/** Returns whether two agents share the same title identity group. */
export function shareCompatibleTitleIdentityGroup(
  left: AgentType | null | undefined,
  right: AgentType | null | undefined
): boolean {
  if (!left || !right) {
    return false
  }
  if (left === right) {
    return true
  }
  const leftGroup = getSyntheticAgentTitleProfile(left)?.titleIdentityGroup
  const rightGroup = getSyntheticAgentTitleProfile(right)?.titleIdentityGroup
  return Boolean(leftGroup && leftGroup === rightGroup)
}
