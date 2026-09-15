import { LayoutGrid, Monitor, MonitorUp, Undo2, PanelsTopLeft } from 'lucide-react'
import { useAppStore } from '@/store'
import { recoverWorkspaceLayout } from '../cross-project-panes/workspace-layout-actions'
import type { CmdJQuickAction } from './quick-actions'
import type { CmdJQuickActionAvailability } from './quick-action-context'

export function getWorkspaceLayoutQuickActions(): CmdJQuickAction[] {
  return [
    {
      id: 'undo-layout-change',
      title: 'Undo Layout Change',
      icon: Undo2,
      run: () => recoverWorkspaceLayout(false)
    },
    {
      id: 'reopen-closed-view',
      title: 'Reopen Closed View',
      icon: PanelsTopLeft,
      run: () => recoverWorkspaceLayout(true)
    },
    {
      id: 'tile-panes-in-window',
      title: 'Tile Panes in This Window',
      icon: LayoutGrid,
      run: () => useAppStore.getState().tileWindowPanes()
    },
    {
      id: 'move-window-to-monitor',
      title: 'Move to Monitor',
      icon: Monitor,
      native: true,
      run: () => window.orcaWorkspaceViews?.showMonitorMenu()
    },
    {
      id: 'bring-windows-to-monitor',
      title: 'Bring All Windows to This Monitor',
      icon: Monitor,
      native: true,
      run: () => window.orcaWorkspaceViews?.bringWindowsToMonitor()
    },
    {
      id: 'tile-windows-current-display',
      title: 'Tile All Windows on This Monitor',
      icon: LayoutGrid,
      native: true,
      run: () => window.orcaWorkspaceViews?.tileWindowsOnMonitor()
    },
    {
      id: 'distribute-windows-displays',
      title: 'Distribute Windows Across Monitors',
      icon: MonitorUp,
      native: true,
      run: () => window.orcaWorkspaceViews?.distributeWindowsAcrossMonitors()
    }
  ].map((action) => ({
    ...action,
    kind: 'action',
    description: action.native
      ? 'Arrange workspace windows while keeping sessions running.'
      : 'Arrange the active panes in a balanced grid.',
    verbKeywords: [action.title.toLowerCase()],
    isAvailable: (): CmdJQuickActionAvailability =>
      action.native && !window.orcaWorkspaceViews
        ? { available: false, reason: 'client-action-unsupported' }
        : { available: true },
    run: async () => {
      if (action.native && !window.orcaWorkspaceViews) {
        return { status: 'unavailable', reason: 'client-action-unsupported' }
      }
      await action.run()
      return { status: 'ok' }
    }
  }))
}
