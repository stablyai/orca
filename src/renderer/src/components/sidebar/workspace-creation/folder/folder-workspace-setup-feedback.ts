import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { getAgentLabel } from '@/lib/agent-catalog/agent-catalog'
import type { FolderWorkspaceCreateResult } from '../../../../../../shared/folder-workspaces/folder-workspace-create'
import type { TuiAgent } from '../../../../../../shared/agent-launch/catalog/tui-agent'

export function showFolderWorkspaceSetupOutcome(
  result: FolderWorkspaceCreateResult,
  quickAgent: TuiAgent | null,
  cancelled: boolean
): void {
  if (result.agentLaunchOutcome?.status === 'failed' && quickAgent && !cancelled) {
    toast.error(
      translate(
        'settings.groupHooks.agentSetupFailed',
        'Could not start {{agent}} because Setup did not complete successfully. Check the Setup tab and try again.',
        { agent: getAgentLabel(quickAgent) }
      )
    )
  } else if (result.warning) {
    toast.warning(result.warning)
  }
}
