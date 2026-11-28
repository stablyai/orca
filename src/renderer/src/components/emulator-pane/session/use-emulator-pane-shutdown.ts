import { emulatorRuntimeTarget } from '@/lib/simulator/runtime/emulator-runtime-target'
import {
  acceptedEmulatorStreamSession,
  emulatorSessionStartedHere,
  noteEmulatorSessionStopped,
  releaseEmulatorStream
} from '@/lib/simulator/runtime/emulator-runtime-attach'
import { useCallback, type Dispatch, type RefObject, type SetStateAction } from 'react'
import { callRuntimeRpc } from '@/runtime/rpc/calls/runtime-rpc-call'
import { useAppStore } from '@/store/index'
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
        const target = emulatorRuntimeTarget(worktreeId)
        const session = acceptedEmulatorStreamSession(worktreeId)
        const started = emulatorSessionStartedHere(worktreeId)
        const res = await callRuntimeRpc<{ deviceUdid?: string } | null>(
          target,
          'emulator.shutdown',
          { ...(deviceTarget ? { device: deviceTarget } : {}), worktree: worktreeId }
        )
        if (started) {
          noteEmulatorSessionStopped(worktreeId, started.generation)
        }
        if (session) {
          releaseEmulatorStream(worktreeId, session)
        }
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
