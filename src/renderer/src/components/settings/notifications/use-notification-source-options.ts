import { useMemo } from 'react'
import { shallow } from 'zustand/shallow'
import { useAppStoreWithHostStatuses } from '@/store/slices/runtime-status/views/use-runtime-status-view'
import { buildNotificationSourceOptions } from '@/attention/notification-sources'

export function useNotificationSourceOptions() {
  const state = useAppStoreWithHostStatuses(
    (s, statuses) => ({
      sshTargetLabels: s.sshTargetLabels,
      sshConnectionStates: s.sshConnectionStates,
      settings: s.settings,
      runtimeEnvironments: s.runtimeEnvironments,
      runtimeStatusByEnvironmentId: statuses
    }),
    shallow
  )
  return useMemo(() => buildNotificationSourceOptions(state), [state])
}
