import { useCallback, useEffect, useRef, useState } from 'react'
import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'
import { useAppStore } from '@/store'
import {
  deviceLabel,
  simulatorPreviewStreamUrl,
  type EmulatorPaneSession,
  type SimulatorDeviceRow
} from './emulator-pane-types'
import { markSimulatorDeviceBooted, markSimulatorDeviceShutdown } from './emulator-device-state'
import { useEmulatorPaneControls } from './use-emulator-pane-controls'
import { useEmulatorPaneSessionEvents } from './use-emulator-pane-session-events'
import {
  consumePrelaunchedSimulatorSession,
  isManualSimulatorLaunchPending
} from '@/lib/simulator-launch-coordination'
import { shutdownManagedSimulatorIfNoPane } from '@/lib/simulator-pane-shutdown-scheduler'
import { buildPrelaunchedEmulatorSessionState } from './emulator-prelaunched-session'
import { useEmulatorPaneManualLaunchEvents } from './use-emulator-pane-manual-launch-events'
import { buildEmulatorPaneSessionView } from './emulator-pane-session-view'
import { resolveEmulatorAttachTarget } from './emulator-attach-target'
import { useEmulatorPaneLifecycle } from './use-emulator-pane-lifecycle'
import { useEmulatorPaneShutdown } from './use-emulator-pane-shutdown'
import { emulatorPaneErrorMessage } from './emulator-pane-error-message'

type UseEmulatorPaneSessionArgs = {
  worktreeId: string
  tabId?: string
  autoAttachOnMount: boolean
}

export function useEmulatorPaneSession({
  worktreeId,
  tabId,
  autoAttachOnMount
}: UseEmulatorPaneSessionArgs) {
  const [devices, setDevices] = useState<SimulatorDeviceRow[]>([])
  const configuredDefaultUdid = useAppStore(
    (state) => state.settings?.mobileEmulatorDefaultDeviceUdid ?? null
  )
  const prelaunchedSessionRef = useRef<EmulatorPaneSession['info'] | null>(
    consumePrelaunchedSimulatorSession(worktreeId)
  )
  const prelaunchedState = buildPrelaunchedEmulatorSessionState(
    prelaunchedSessionRef.current,
    configuredDefaultUdid
  )
  const [selectedUdid, setSelectedUdid] = useState<string | null>(prelaunchedState.selectedUdid)
  const [session, setSession] = useState<EmulatorPaneSession | null>(prelaunchedState.session)
  const [loading, setLoading] = useState(
    !prelaunchedState.session && isManualSimulatorLaunchPending(worktreeId)
  )
  const [error, setError] = useState<string | null>(null)
  const [streamKey, setStreamKey] = useState<string | null>(prelaunchedState.streamKey)
  const mountedRef = useRef(true)
  const liveTargetRef = useRef<string | null>(prelaunchedState.liveTarget)
  const deviceRefreshErrorRef = useRef<unknown>(null)
  const suppressAutoAttachRef = useRef(false)
  const { sendTap, sendButton, sendGesture, sendRotate } = useEmulatorPaneControls(worktreeId)

  const refreshDevices = useCallback(async (bootedTarget?: string | null) => {
    try {
      const list = (await callRuntimeRpc(
        { kind: 'local' },
        'emulator.listSimulators',
        {}
      )) as SimulatorDeviceRow[]
      const next = markSimulatorDeviceBooted(list, bootedTarget)
      if (!mountedRef.current) {
        return next
      }
      const hadRefreshError = deviceRefreshErrorRef.current !== null
      deviceRefreshErrorRef.current = null
      setDevices(next)
      if (hadRefreshError) {
        setError(null)
      }
      return next
    } catch (error) {
      deviceRefreshErrorRef.current = error
      if (mountedRef.current) {
        setDevices([])
        setError(emulatorPaneErrorMessage(error, 'Could not list emulator devices.'))
      }
      return []
    }
  }, [])

  const applySession = useCallback(
    (info: EmulatorPaneSession['info'], attached = true, deviceRows = devices) => {
      if (!mountedRef.current) {
        return
      }
      const target = info?.deviceUdid || info?.device
      const rows = attached ? markSimulatorDeviceBooted(deviceRows, target) : deviceRows
      if (attached && rows !== deviceRows) {
        setDevices(rows)
      }
      const row = rows.find((d) => d.udid === target || d.name === target)
      const displayName = row?.name || deviceLabel(info)
      const enriched = { ...info, displayName, state: attached ? 'Booted' : info?.state }
      setSession({ attached, info: enriched })
      liveTargetRef.current = attached ? target || null : null
      setLoading(false)
      if (attached) {
        suppressAutoAttachRef.current = false
      }
      setError(null)
      if (attached && simulatorPreviewStreamUrl(enriched)) {
        setStreamKey(String(Date.now()))
      }
      if (info?.deviceUdid || info?.device) {
        setSelectedUdid(info.deviceUdid || info.device || null)
      }
      if (tabId) {
        useAppStore.getState().setTabLabel(tabId, displayName)
      }
    },
    [devices, tabId]
  )

  const clearSessionAfterShutdown = useCallback(
    (deviceTarget?: string | null) => {
      if (!mountedRef.current) {
        return
      }
      const target =
        deviceTarget || session?.info?.deviceUdid || session?.info?.device || selectedUdid
      setDevices((current) => markSimulatorDeviceShutdown(current, target))
      setSession(null)
      liveTargetRef.current = null
      suppressAutoAttachRef.current = true
      setStreamKey(null)
      setError(null)
      if (tabId) {
        const row = devices.find((device) => device.udid === target || device.name === target)
        useAppStore.getState().setTabLabel(tabId, row?.name || 'Mobile Emulator')
      }
    },
    [devices, selectedUdid, session, tabId]
  )

  const attach = useCallback(
    async (deviceTarget?: string) => {
      if (loading) {
        return
      }
      suppressAutoAttachRef.current = false
      setLoading(true)
      setError(null)
      if (tabId) {
        useAppStore.getState().setTabLabel(tabId, 'Starting…')
      }
      let requestedTarget: string | undefined
      try {
        let list = devices
        if (list.length === 0) {
          list = (await refreshDevices()) ?? []
        }
        if (list.length === 0 && deviceRefreshErrorRef.current) {
          throw deviceRefreshErrorRef.current
        }
        const target = resolveEmulatorAttachTarget({
          configuredDefaultUdid,
          devices: list,
          deviceTarget,
          selectedUdid
        })
        if (!target) {
          throw new Error(
            'No emulator devices found. Open Xcode → Settings → Platforms and add an iOS Simulator.'
          )
        }
        requestedTarget = target
        setSelectedUdid(target)
        if (target !== liveTargetRef.current) {
          // Why: switching devices should show an explicit connecting state,
          // not a frozen frame from the previously attached emulator.
          setSession(null)
          setStreamKey(null)
          liveTargetRef.current = null
        }
        const res = (await callRuntimeRpc({ kind: 'local' }, 'emulator.attach', {
          device: target,
          worktree: worktreeId,
          focus: false
        })) as { attached?: boolean; info?: EmulatorPaneSession['info'] }
        if (!mountedRef.current) {
          // Why: attach can finish after the tab closes, after the earlier
          // unmount shutdown already no-op'd because the session was not registered yet.
          await shutdownManagedSimulatorIfNoPane(worktreeId, tabId)
          return
        }
        const attached = !!res?.attached
        const bootedTarget = res?.info?.deviceUdid || res?.info?.device || target
        const nextList = attached ? markSimulatorDeviceBooted(list, bootedTarget) : list
        if (attached) {
          setDevices(nextList)
        }
        applySession(res?.info, attached, nextList)
        if (attached) {
          void refreshDevices(bootedTarget)
        }
      } catch (e: unknown) {
        if (requestedTarget && liveTargetRef.current === requestedTarget) {
          return
        }
        // Why: setup failures otherwise trigger the mount auto-attach loop again
        // and erase the actionable error before the user can read it.
        suppressAutoAttachRef.current = true
        const msg = emulatorPaneErrorMessage(
          e,
          'Could not start the emulator. Check that Xcode is installed and try another device.'
        )
        setError(msg)
        if (tabId) {
          useAppStore.getState().setTabLabel(tabId, 'Mobile Emulator')
        }
      } finally {
        if (mountedRef.current) {
          setLoading(false)
        }
      }
    },
    [
      applySession,
      configuredDefaultUdid,
      devices,
      loading,
      refreshDevices,
      selectedUdid,
      tabId,
      worktreeId
    ]
  )

  useEffect(() => {
    if (!selectedUdid && configuredDefaultUdid) {
      setSelectedUdid(configuredDefaultUdid)
    }
  }, [configuredDefaultUdid, selectedUdid])

  const shutdown = useEmulatorPaneShutdown({
    loading,
    mountedRef,
    refreshDevices,
    setError,
    setLoading,
    tabId,
    worktreeId
  })

  useEmulatorPaneLifecycle({ mountedRef, refreshDevices, tabId, worktreeId })

  useEffect(() => {
    if (!autoAttachOnMount || session || loading || suppressAutoAttachRef.current) {
      return
    }
    void attach()
  }, [attach, autoAttachOnMount, loading, session])

  useEmulatorPaneSessionEvents({
    worktreeId,
    applySession,
    refreshDevices,
    clearSessionAfterShutdown
  })

  useEmulatorPaneManualLaunchEvents({
    worktreeId,
    tabId,
    session,
    mountedRef,
    setLoading,
    setError
  })

  const view = buildEmulatorPaneSessionView({ devices, selectedUdid, session })

  return {
    devices,
    selectedUdid,
    setSelectedUdid,
    session,
    loading,
    error,
    attach,
    shutdown,
    refreshDevices,
    sendTap,
    sendButton,
    sendGesture,
    sendRotate,
    displayName: view.displayName,
    previewUrl: view.previewUrl,
    wsUrl: view.wsUrl,
    streamKey: streamKey ?? undefined,
    isLive: view.isLive,
    selectedDevice: view.selectedDevice
  }
}
