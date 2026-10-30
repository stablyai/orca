import { classifyTitleActivity } from './pane-agent-evidence'
import type { ParsedAgentStatusPayload } from '../../../shared/agent-status-types'
import {
  getSyntheticAgentTerminalTitle,
  getSyntheticAgentTitleProfile
} from '../../../shared/synthetic-agent-title'

export function resolveAgentStatusTerminalTitle(
  payload: Pick<ParsedAgentStatusPayload, 'agentType' | 'state'>,
  currentTitle: string | undefined
): string | undefined {
  const syntheticTitle = getSyntheticAgentTerminalTitle(payload.agentType, payload.state)
  if (!syntheticTitle) {
    return currentTitle
  }
  if (shouldReplaceCurrentTitle(payload, currentTitle)) {
    return syntheticTitle
  }
  return currentTitle
}

function shouldReplaceCurrentTitle(
  payload: Pick<ParsedAgentStatusPayload, 'agentType' | 'state'>,
  currentTitle: string | undefined
): boolean {
  if (!currentTitle?.trim()) {
    return true
  }
  const currentStatus = classifyTitleActivity(currentTitle)
  if (currentStatus === 'working') {
    return true
  }
  if (payload.state === 'done' && currentStatus === 'permission') {
    return true
  }
  const profile = getSyntheticAgentTitleProfile(payload.agentType)
  if (!profile) {
    return false
  }
  // Cursor’s bare completion title is a detector no-op; explicit status needs an idle label.
  if (currentTitle.trim().toLowerCase() === profile.workingLabel.toLowerCase()) {
    return true
  }
  return payload.state === 'blocked' || payload.state === 'waiting'
}
