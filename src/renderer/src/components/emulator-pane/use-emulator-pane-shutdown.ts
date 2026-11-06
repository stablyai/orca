import { useCallback, type Dispatch, type RefObject, type SetStateAction } from 'react'
import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'
import { useAppStore } from '@/store'
import { EMULATOR_LOCAL_SHUTDOWN_EVENT } from './use-emulator-pane-session-events'
import { emulatorShutdownErrorText } from './emulator-pane-error-copy'

type UseEmulatorPaneShutdownArgs = {
  loading: boolean
  mountedRef: RefObject<boolean>
  refreshDevices: () => Promise<unknown[]>
  setError: Dispatch<SetStateAction<string | null>>
  setLoading: Dispatch<SetStateAction<boolean>>
  tabId?: string
  worktreeId: string
}

export function useEmulatorPaneShutdown({
  loading,
  mountedRef,
  refreshDevices,
  setError,
  setLoading,
  tabId,
  worktreeId
}: UseEmulatorPaneShutdownArgs) {
  return useCallback(
    async (deviceTarget?: string) => {
      if (loading) {
        return
      }
      setLoading(true)
      setError(null)
      if (tabId) {
        useAppStore.getState().setTabLabel(tabId, 'Shutting down…')
      }
      try {
        const res = (await callRuntimeRpc({ kind: 'local' }, 'emulator.shutdown', {
          ...(deviceTarget ? { device: deviceTarget } : {}),
          worktree: worktreeId
        })) as { deviceUdid?: string }
        const shutdownTarget = res?.deviceUdid || deviceTarget
        window.dispatchEvent(
          new CustomEvent(EMULATOR_LOCAL_SHUTDOWN_EVENT, {
            detail: { worktreeId, deviceUdid: shutdownTarget }
          })
        )
        void refreshDevices()
      } catch (e: unknown) {
        setError(emulatorShutdownErrorText(e))
      } finally {
        if (mountedRef.current) {
          setLoading(false)
        }
      }
    },
    [loading, mountedRef, refreshDevices, setError, setLoading, tabId, worktreeId]
  )
}
