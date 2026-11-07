import { useCallback } from 'react'
import { useDetectedSystemMonitors } from '@/hooks/useDetectedSystemMonitors'
import type { AgentDetectionTarget } from '@/hooks/useDetectedAgents'
import { launchSystemMonitorInNewTab } from '@/lib/launch-system-monitor-in-new-tab'
import type { SystemMonitorDescriptor } from '../../../../shared/system-monitors'

export function useTabBarSystemMonitors({
  worktreeId,
  groupId,
  open,
  target,
  onBeforeLaunch
}: {
  worktreeId: string
  groupId: string
  open: boolean
  target: AgentDetectionTarget | undefined
  onBeforeLaunch: () => void
}): {
  systemMonitors: readonly SystemMonitorDescriptor[]
  handleLaunchSystemMonitor: (monitor: SystemMonitorDescriptor) => void
} {
  const systemMonitors = useDetectedSystemMonitors(worktreeId, open, target)
  const handleLaunchSystemMonitor = useCallback(
    (monitor: SystemMonitorDescriptor): void => {
      onBeforeLaunch()
      launchSystemMonitorInNewTab({ monitor, worktreeId, groupId })
    },
    [groupId, onBeforeLaunch, worktreeId]
  )
  return { systemMonitors, handleLaunchSystemMonitor }
}
