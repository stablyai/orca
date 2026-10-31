import type { AgentPermissionMode } from '../../../../shared/tui-agent-permissions'
import { agentPermissionChoiceLabel } from './AgentPermissionChoiceControls'

export function agentPermissionModeChoice(mode: Exclude<AgentPermissionMode, 'mixed'>) {
  return mode === 'manual' ? 'own' : mode === 'yolo' ? 'full-access' : 'auto'
}

export function agentPermissionModeLabel(mode: Exclude<AgentPermissionMode, 'mixed'>): string {
  return agentPermissionChoiceLabel(agentPermissionModeChoice(mode), null)
}
