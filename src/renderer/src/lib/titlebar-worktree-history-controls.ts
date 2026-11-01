import type { UISlice } from '@/store/slices/ui'
import { isPluginPanelTabKey } from '../../../shared/plugins/frames/plugin-tab-key'

/** Buttons and shortcut handlers share the same canonical page-route eligibility. */
export function shouldShowWorktreeHistoryControls(activeView: UISlice['activeView']): boolean {
  return (
    activeView === 'terminal' ||
    activeView === 'tasks' ||
    activeView === 'automations' ||
    activeView === 'artifacts' ||
    activeView === 'skills' ||
    isPluginPanelTabKey(activeView)
  )
}
