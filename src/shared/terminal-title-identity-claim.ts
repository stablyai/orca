import { stripLeadingAgentTitleDecorationOrEmpty } from './agent-title-decoration'
import { isOpenCodeNativeTitle } from './opencode-terminal-title'
import { isLegacyPiCompatibleTitle } from './pi-compatible-synthetic-title'
import { getSyntheticAgentTitleProfile } from './synthetic-agent-title'
import { isClaudeIdentityFrameTitle, isGrokRotatingWorkingTitle } from './terminal-title-agent-type'
import { getWrapperTitleSegments } from './terminal-title-wrapper-segments'
import { TUI_AGENT_DISPLAY_NAMES } from './tui-agent-display-names'
import type { TuiAgent } from './tui-agent'

/** Whether a terminal title presents an agent identity rather than mentioning it in task text. */
export function titlePresentsAgent(title: string, agent: TuiAgent): boolean {
  if (agent === 'claude') {
    return isClaudeIdentityFrameTitle(title)
  }
  if (agent === 'opencode' && isOpenCodeNativeTitle(title)) {
    return true
  }
  if (agent === 'grok' && isGrokRotatingWorkingTitle(title)) {
    return true
  }
  if (agent === 'pi' && isLegacyPiCompatibleTitle(title)) {
    return true
  }

  const displayName = TUI_AGENT_DISPLAY_NAMES[agent]
  const profile = getSyntheticAgentTitleProfile(agent)
  const identityNames = new Set([
    displayName,
    `${displayName} CLI`,
    `${displayName} Code`,
    `${displayName} Agent`,
    ...(profile ? [profile.workingLabel, profile.permissionLabel, profile.idleLabel] : [])
  ])
  return getWrapperTitleSegments(title).some((segment) => {
    const normalized = stripLeadingAgentTitleDecorationOrEmpty(segment).trim().toLowerCase()
    return [...identityNames].some((name) => {
      const identityName = name.toLowerCase()
      const suffix = normalized.slice(identityName.length)
      return (
        normalized.startsWith(identityName) &&
        (suffix.length === 0 || suffix.startsWith(':') || suffix.startsWith(' - action required'))
      )
    })
  })
}
