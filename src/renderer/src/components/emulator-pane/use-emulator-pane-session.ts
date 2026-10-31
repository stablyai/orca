import { useEmulatorDeviceInventory } from './use-emulator-device-inventory'
import {
  getEmulatorOpeningMode,
  type EmulatorSelectionRequired
} from '../../../../shared/emulator-opening-preferences'
import { supportsEmulatorOpeningPreferences } from '@/lib/emulator-opening-preferences-capability'
import { useCallback, useEffect, useRef, useState } from 'react'
import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'
import { useAppStore } from '@/store'
import {
  deviceLabel,
  simulatorPreviewStreamUrl,
  type EmulatorPaneSession
} from './emulator-pane-types'
import { markSimulatorDeviceShutdown } from './emulator-device-state'
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
import { emulatorStartErrorText, noEmulatorDevicesError } from './emulator-pane-error-copy'
import { SIMULATOR_DEFAULT_TAB_LABEL, formatSimulatorTabLabel } from '@/lib/simulator-tab-label'

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
  const configuredDefaultUdid = useAppStore((state) =>
    state.settings && getEmulatorOpeningMode(state.settings) === 'specific'
      ? (state.settings.mobileEmulatorDefaultDeviceUdid ?? null)
      : null
  )
  // Consume the handoff only at mount; useRef(expr) would consume and discard later prelaunches on rerender.
  const [prelaunchedSession] = useState<EmulatorPaneSession['info'] | null>(() =>
    consumePrelaunchedSimulatorSession(worktreeId)
  )
  const prelaunchedState = buildPrelaunchedEmulatorSessionState(
    prelaunchedSession,
    configuredDefaultUdid
  )
  const [selectedUdid, setSelectedUdid] = useState<string | null>(prelaunchedState.selectedUdid)
  const [session, setSession] = useState<EmulatorPaneSession | null>(prelaunchedState.session)
  const [loading, setLoading] = useState(
    !prelaunchedState.session && isManualSimulatorLaunchPending(worktreeId)
  )
  const [selectionRequired, setSelectionRequired] = useState<EmulatorSelectionRequired | null>(null)
  const attachRequestRef = useRef(0)
  const [error, setError] = useState<string | null>(null)
  const [streamKey, setStreamKey] = useState<string | null>(prelaunchedState.streamKey)
  const mountedRef = useRef(true)
  const liveTargetRef = useRef<string | null>(prelaunchedState.liveTarget)
  const { devices, setDevices, refreshDevices, deviceRefreshErrorRef, markDeviceBooted } =
    useEmulatorDeviceInventory(mountedRef, setError)
  const suppressAutoAttachRef = useRef(false)
  const refreshStreamKey = useCallback(() => setStreamKey(String(Date.now())), [])
  const {
    sendTap,
    sendButton,
    sendGesture,
    sendRotate,
    visualOrientation,
    resetVisualOrientation
  } = useEmulatorPaneControls(worktreeId, refreshStreamKey)

  const applySession = useCallback(
    (info: EmulatorPaneSession['info'], attached = true, deviceRows = devices) => {
      if (!mountedRef.current) {
        return
      }
      const target = info?.deviceUdid || info?.device
      const rows = attached ? markDeviceBooted(deviceRows, target) : deviceRows
      if (attached && target && target !== liveTargetRef.current) {
        resetVisualOrientation()
      }
      const row = rows.find((d) => d.udid === target || d.name === target)
      const displayName = row?.name || deviceLabel(info)
      const enriched = { ...info, displayName, state: attached ? 'Booted' : info?.state }
      setSession({ attached, info: enriched })
      liveTargetRef.current = attached ? target || null : null
      setLoading(false)
      if (attached) {
        setSelectionRequired(null)
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
    [devices, markDeviceBooted, resetVisualOrientation, tabId]
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
      resetVisualOrientation()
      setError(null)
      if (tabId) {
        const row = devices.find((device) => device.udid === target || device.name === target)
        useAppStore.getState().setTabLabel(tabId, row?.name || SIMULATOR_DEFAULT_TAB_LABEL)
      }
    },
    [devices, resetVisualOrientation, selectedUdid, session, setDevices, tabId]
  )

  const attach = useCallback(
    async (deviceTarget?: string, automatic = false) => {
      if (loading) {
        return
      }
      const request = ++attachRequestRef.current
      suppressAutoAttachRef.current = false
      setSelectionRequired(null)
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
        const supportsPreferences = await supportsEmulatorOpeningPreferences()
        const target =
          supportsPreferences && automatic
            ? undefined
            : resolveEmulatorAttachTarget({
                configuredDefaultUdid,
                devices: list,
                deviceTarget,
                selectedUdid
              })
        if (!target && !supportsPreferences) {
          throw noEmulatorDevicesError()
        }
        requestedTarget = target
        setSelectedUdid(target ?? null)
        if (target !== liveTargetRef.current) {
          // Clear the old device’s frame so switching shows a connecting state.
          setSession(null)
          setStreamKey(null)
          liveTargetRef.current = null
          resetVisualOrientation()
        }
        const res = await callRuntimeRpc<{
          attached?: boolean
          info?: EmulatorPaneSession['info']
          selectionRequired?: EmulatorSelectionRequired
        }>({ kind: 'local' }, 'emulator.attach', {
          ...(target ? { device: target } : {}),
          ...(supportsPreferences ? { userInitiated: true } : {}),
          worktree: worktreeId,
          focus: false
        })
        if (request !== attachRequestRef.current) {
          return
        }
        if (!mountedRef.current) {
          // Attach may finish after unmount cleanup ran before the session was registered.
          await shutdownManagedSimulatorIfNoPane(worktreeId, tabId)
          return
        }
        if (res.selectionRequired) {
          suppressAutoAttachRef.current = true
          setSelectionRequired(res.selectionRequired)
          setSelectedUdid(null)
          if (tabId) {
            useAppStore.getState().setTabLabel(tabId, SIMULATOR_DEFAULT_TAB_LABEL)
          }
          return
        }
        const attached = !!res?.attached
        const bootedTarget = res?.info?.deviceUdid || res?.info?.device || target
        const nextList = attached ? markDeviceBooted(list, bootedTarget) : list
        applySession(res?.info, attached, nextList)
        if (attached) {
          void refreshDevices(bootedTarget)
        }
      } catch (e: unknown) {
        if (request !== attachRequestRef.current) {
          return
        }
        if (requestedTarget && liveTargetRef.current === requestedTarget) {
          return
        }
        // Prevent mount auto-attach from erasing actionable setup errors.
        suppressAutoAttachRef.current = true
        setError(emulatorStartErrorText(e))
        if (tabId) {
          useAppStore.getState().setTabLabel(tabId, SIMULATOR_DEFAULT_TAB_LABEL)
        }
      } finally {
        if (mountedRef.current && request === attachRequestRef.current) {
          setLoading(false)
        }
      }
    },
    [
      applySession,
      deviceRefreshErrorRef,
      markDeviceBooted,
      configuredDefaultUdid,
      devices,
      loading,
      refreshDevices,
      resetVisualOrientation,
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
    void attach(undefined, true)
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
    selectionRequired,
    attach,
    shutdown,
    refreshDevices,
    sendTap,
    sendButton,
    sendGesture,
    sendRotate,
    visualOrientation,
    displayName: formatSimulatorTabLabel(view.displayName),
    previewUrl: view.previewUrl,
    wsUrl: view.wsUrl,
    streamKey: streamKey ?? undefined,
    isLive: view.isLive,
    selectedDevice: view.selectedDevice
  }
}
