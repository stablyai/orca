import { useMemo } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { buildNotificationSourceOptions } from '@/attention/notification-sources'
import { useAppStoreWithChannels } from '@/store/channels/use-app-store-with-channels'

export function useNotificationSourceOptions() {
  const state = useAppStoreWithChannels(
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
