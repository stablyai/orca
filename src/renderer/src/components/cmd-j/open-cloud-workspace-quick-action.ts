import { Cloud } from 'lucide-react'
import { translate } from '@/i18n/i18n'
import type { CmdJQuickAction } from './quick-actions'

/** "Open cloud workspace…": a teammate's shared one, or one started on another computer. */
export function getOpenCloudWorkspaceQuickAction(): CmdJQuickAction {
  return {
    id: 'open-cloud-workspace',
    kind: 'action',
    title: translate('components.cloudWorkspaces.picker.menuItem', 'Open cloud workspace…'),
    description: translate(
      'components.cloudWorkspaces.picker.paletteDescription',
      'Open a cloud workspace that isn’t in your sidebar yet.'
    ),
    icon: Cloud,
    verbKeywords: [
      translate('components.cloudWorkspaces.picker.verbs.cloudWorkspace', 'cloud workspace'),
      translate('components.cloudWorkspaces.picker.verbs.sharedWorkspace', 'shared workspace'),
      translate('components.cloudWorkspaces.picker.verbs.teammate', 'teammate'),
      translate('components.cloudWorkspaces.picker.verbs.orcaCloud', 'orca cloud')
    ],
    // Unavailable actions are left out of the palette, so this stays hidden without Orca Cloud.
    isAvailable: (ctx) =>
      ctx.openCloudWorkspacePicker
        ? { available: true }
        : { available: false, reason: 'no-orca-cloud' },
    run: async (ctx) => {
      if (!ctx.openCloudWorkspacePicker) {
        return { status: 'unavailable', reason: 'no-orca-cloud' }
      }
      ctx.openCloudWorkspacePicker()
      return { status: 'ok' }
    }
  }
}
