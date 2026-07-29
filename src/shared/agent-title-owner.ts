import { detectAgentStatusFromTitle, getAgentLabel } from './agent-detection'
import type { AgentStatusEntry, AgentType } from './agent-status-types'
import {
  getSyntheticAgentTitleProfile,
  SYNTHETIC_AGENT_TITLE_PROFILES,
  type SyntheticAgentTitleProfile
} from './synthetic-agent-title'
import { isLegacyPiCompatibleTitle } from './pi-compatible-synthetic-title'

type TitleProfileMatch = {
  profile: SyntheticAgentTitleProfile
  sourceTitle: string
}

type TitleLabelProfileMatch = Pick<TitleProfileMatch, 'profile'>

const COMPATIBLE_IDLE_TITLE_RE = /(?<![\w./\\-])(?:ready|idle|done)(?![\w-])/i

/**
 * Resolves the synthetic title profile matching a given agent label.
 */
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

/**
 * Resolves the synthetic title profile matching a given terminal title.
 */
function getProfileForTitle(title: string): TitleProfileMatch | null {
  // Multiplexers/session wrappers prefix dynamic titles with ` | `, so inspect
  // each suffix to preserve the inner compatible agent identity.
  const candidates = [title]
  let wrapperSeparatorIndex = title.indexOf(' | ')
  while (wrapperSeparatorIndex >= 0) {
    const wrappedPaneTitle = title.slice(wrapperSeparatorIndex + 3).trim()
    if (wrappedPaneTitle && !candidates.includes(wrappedPaneTitle)) {
      candidates.push(wrappedPaneTitle)
    }
    wrapperSeparatorIndex = title.indexOf(' | ', wrapperSeparatorIndex + 3)
  }

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

/**
 * Why: unknown-launch remote sessions need to wait for foreground ownership
 * before publishing title frames whose identity can be re-owned.
 */
export function hasCompatibleAgentTitleIdentity(title: string): boolean {
  return Boolean(getProfileForTitle(title)?.profile.titleIdentityGroup)
}

/**
 * Detects the agent status (working, permission, idle) from a terminal title,
 * accounting for legacy Pi titles.
 */
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

/**
 * Checks if a title indicates an agent is waiting for permissions or input.
 */
function hasPermissionSuffix(title: string, sourceProfile: SyntheticAgentTitleProfile): boolean {
  const normalizedTitle = title.trim().toLowerCase()
  return (
    normalizedTitle === sourceProfile.permissionLabel.toLowerCase() ||
    normalizedTitle.includes('action required') ||
    normalizedTitle.includes('permission') ||
    normalizedTitle.includes('waiting')
  )
}

/**
 * Checks if a title indicates an agent is idle or ready.
 */
function hasIdleSuffix(title: string, sourceProfile: SyntheticAgentTitleProfile): boolean {
  const normalizedTitle = title.trim().toLowerCase()
  return (
    normalizedTitle === sourceProfile.idleLabel.toLowerCase() ||
    COMPATIBLE_IDLE_TITLE_RE.test(title)
  )
}

/**
 * Why: remote OMP surfaces may report Pi as the live status identity, while
 * launch ownership still identifies the user-selected agent.
 */
export function resolveCompatibleAgentTypeForOwner(
  incomingAgentType: AgentType | null | undefined,
  ownerAgentType: AgentType | null | undefined
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

/**
 * Why: Pi-compatible title frames can come from the wrapped harness during
 * active work, so render them through the stable owner profile.
 */
export function normalizeCompatibleAgentTitleForOwner(
  title: string,
  ownerAgentType: AgentType | null | undefined
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

/**
 * Why: mirrored remote status entries must keep the owner and title in sync
 * or later snapshots repaint the same tab under the wrapper agent.
 */
export function normalizeCompatibleAgentStatusEntryForOwner(
  entry: AgentStatusEntry,
  ownerAgentType: AgentType | null | undefined
): AgentStatusEntry {
  const agentType = resolveCompatibleAgentTypeForOwner(entry.agentType, ownerAgentType)
  const terminalTitle = entry.terminalTitle
    ? normalizeCompatibleAgentTitleForOwner(entry.terminalTitle, agentType ?? ownerAgentType)
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
