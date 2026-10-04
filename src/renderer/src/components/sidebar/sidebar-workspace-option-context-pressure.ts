import { translate } from '@/i18n/i18n'
import type { WorktreeCardPropertyOption } from './sidebar-workspace-option-items'

// Why gated: the property renders nothing while experimentalContextPressure is
// off, and a checkbox with no visible effect reads as broken.
export const CONTEXT_PRESSURE_WORKTREE_CARD_PROPERTY_OPTION: WorktreeCardPropertyOption = {
  id: 'context-pressure',
  properties: ['context-pressure'],
  get label() {
    return translate(
      'auto.components.sidebar.SidebarWorkspaceOptionsMenu.contextPressure',
      'Context pressure'
    )
  }
}
