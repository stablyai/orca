import type { AgentPermissionMode } from '../../../../../../shared/agent-launch/permissions/tui-agent-permissions'
import { agentPermissionChoiceLabel } from '../../../agent/launch-settings/AgentPermissionChoiceControls'
import type { Translate } from '../../../../i18n/use-translate'

export function agentPermissionModeChoice(mode: Exclude<AgentPermissionMode, 'mixed'>) {
  return mode === 'manual' ? 'own' : mode === 'yolo' ? 'full-access' : 'auto'
}

export function agentPermissionModeLabel(
  mode: Exclude<AgentPermissionMode, 'mixed'>,
  t?: Translate
): string {
  return agentPermissionChoiceLabel(agentPermissionModeChoice(mode), null, t)
}
