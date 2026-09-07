import { Undo2, PanelsTopLeft, Monitor } from 'lucide-react'
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
    }
  ].map((action) => ({
    ...action,
    kind: 'action',
    description: 'Restore presentation while keeping sessions running.',
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
