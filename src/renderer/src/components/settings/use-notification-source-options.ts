import { useMemo } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useAppStore } from '@/store'
import { buildNotificationSourceOptions } from '@/attention/notification-sources'

export function useNotificationSourceOptions() {
  const state = useAppStore(
    useShallow((s) => ({
      sshTargetLabels: s.sshTargetLabels,
      sshConnectionStates: s.sshConnectionStates,
      settings: s.settings,
      runtimeEnvironments: s.runtimeEnvironments,
      runtimeStatusByEnvironmentId: s.runtimeStatusByEnvironmentId
    }))
  )
  return useMemo(() => buildNotificationSourceOptions(state), [state])
}
