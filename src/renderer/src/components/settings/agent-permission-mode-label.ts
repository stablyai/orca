import type { AgentPermissionMode } from '../../../../shared/tui-agent-permissions'
import { translate } from '@/i18n/i18n'

export function agentPermissionModeLabel(mode: Exclude<AgentPermissionMode, 'mixed'>): string {
  return mode === 'auto'
    ? translate('settings.agents.autoPermissions', 'Auto')
    : mode === 'yolo'
      ? translate('auto.components.settings.AgentsPane.agentPermissionsYolo', 'Yolo')
      : translate('auto.components.settings.AgentsPane.agentPermissionsManual', 'Manual')
}
