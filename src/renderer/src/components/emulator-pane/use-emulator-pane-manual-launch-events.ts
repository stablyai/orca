import { useEffect } from 'react'
import { useAppStore } from '@/store'
import type { EmulatorPaneSession } from './emulator-pane-types'
import {
  EMULATOR_MANUAL_LAUNCH_FAILED_EVENT,
  EMULATOR_MANUAL_LAUNCH_STARTED_EVENT
} from '@/lib/simulator-launch-coordination'

type UseEmulatorPaneManualLaunchEventsArgs = {
  worktreeId: string
  tabId?: string
  session: EmulatorPaneSession | null
  mountedRef: { current: boolean }
  setLoading: (loading: boolean) => void
  setError: (message: string | null) => void
}

export function useEmulatorPaneManualLaunchEvents({
  worktreeId,
  tabId,
  session,
  mountedRef,
  setLoading,
  setError
}: UseEmulatorPaneManualLaunchEventsArgs): void {
  useEffect(() => {
    const onStarted = (ev: Event): void => {
      const detail = (ev as CustomEvent).detail as { worktreeId?: string }
      if ((detail?.worktreeId && detail.worktreeId !== worktreeId) || !mountedRef.current) {
        return
      }
      if (session) {
        return
      }
      setLoading(true)
      setError(null)
      if (tabId) {
        useAppStore.getState().setTabLabel(tabId, 'Starting…')
      }
    }
    window.addEventListener(EMULATOR_MANUAL_LAUNCH_STARTED_EVENT, onStarted)
    return () => window.removeEventListener(EMULATOR_MANUAL_LAUNCH_STARTED_EVENT, onStarted)
  }, [mountedRef, session, setError, setLoading, tabId, worktreeId])

  useEffect(() => {
    const onFailed = (ev: Event): void => {
      const detail = (ev as CustomEvent).detail as { message?: string; worktreeId?: string }
      if ((detail?.worktreeId && detail.worktreeId !== worktreeId) || !mountedRef.current) {
        return
      }
      if (session) {
        return
      }
      setLoading(false)
      setError(detail?.message ?? 'Could not start the emulator.')
      if (tabId) {
        useAppStore.getState().setTabLabel(tabId, 'Mobile Emulator')
      }
    }
    window.addEventListener(EMULATOR_MANUAL_LAUNCH_FAILED_EVENT, onFailed)
    return () => window.removeEventListener(EMULATOR_MANUAL_LAUNCH_FAILED_EVENT, onFailed)
  }, [mountedRef, session, setError, setLoading, tabId, worktreeId])
}
