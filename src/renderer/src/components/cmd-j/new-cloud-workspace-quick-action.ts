import { Cloud } from 'lucide-react'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store/index'
import { openNewCloudWorkspace } from '@/hooks/ipc-events/new-workspace-command'
import { getCloudWorkspacesAvailableSnapshot } from '@/components/cloud-workspaces/use-cloud-workspaces'
import type { CmdJQuickAction } from './quick-actions'

/** "New cloud workspace": the composer on Orca Cloud (spec D8). Hidden in builds without Orca Cloud. */
export function getNewCloudWorkspaceQuickAction(): CmdJQuickAction {
  return {
    id: 'new-cloud-workspace',
    kind: 'action',
    title: translate('keybindings.title.workspaceCreateCloud', 'New cloud workspace'),
    description: translate(
      'components.cmdJ.newCloudWorkspace.description',
      'Start a workspace in Orca Cloud.'
    ),
    icon: Cloud,
    verbKeywords: [
      translate('components.cmdJ.newCloudWorkspace.verbs.newCloud', 'new cloud workspace'),
      translate('components.cmdJ.newCloudWorkspace.verbs.orcaCloud', 'orca cloud'),
      translate('components.cmdJ.newCloudWorkspace.verbs.sandbox', 'sandbox')
    ],
    // Unavailable actions are left out of the palette, so builds without Orca Cloud never list it.
    isAvailable: () =>
      getCloudWorkspacesAvailableSnapshot() === true
        ? { available: true }
        : { available: false, reason: 'loading' },
    run: async () => {
      openNewCloudWorkspace(useAppStore.getState(), 'command_palette')
      return { status: 'ok' }
    }
  }
}
