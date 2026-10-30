import type { UISlice } from '@/store/slices/ui'
import { isPluginPanelTabKey } from '../../../shared/plugins/frames/plugin-tab-key'

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
