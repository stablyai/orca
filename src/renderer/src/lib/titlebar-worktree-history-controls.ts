import type { UISlice } from '@/store/slices/ui'

export function shouldShowWorktreeHistoryControls(activeView: UISlice['activeView']): boolean {
  return activeView === 'terminal' || activeView === 'tasks' || activeView === 'automations'
}
