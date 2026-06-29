import { useCallback, useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'
import type { MobileReverseTunnelEntry } from '../../../../shared/mobile-reverse-tunnel'
import type { SshTarget } from '../../../../shared/ssh-types'
import { translate } from '@/i18n/i18n'

export const DEFAULT_REMOTE_PORT = '6768'
export const DEFAULT_LOCAL_PORT = '6768'

type MobileRemoteAccessStateArgs = {
  onGenerateTunnelQr: (address: string) => void
}

export function formatMobileRemoteTargetLabel(target: SshTarget): string {
  const host = target.configHost ?? target.host
  return `${target.label} (${target.username}@${host})`
}

export function parseMobileRemotePort(value: string): number | null {
  const port = Number(value)
  return Number.isInteger(port) && port > 0 && port <= 65535 ? port : null
}

export function parseMobileRuntimeEndpointPort(endpoint: string | null): string | null {
  if (!endpoint) {
    return null
  }
  try {
    const port = new URL(endpoint).port
    return parseMobileRemotePort(port) === null ? null : port
  } catch {
    return null
  }
}

export function useMobileRemoteAccessState({ onGenerateTunnelQr }: MobileRemoteAccessStateArgs): {
  targets: SshTarget[]
  selectedTargetId: string
  selectedTarget: SshTarget | null
  publicHost: string
  remotePort: string
  localPort: string
  activeTunnel: MobileReverseTunnelEntry | null
  loadingTargets: boolean
  startingTunnel: boolean
  stoppingTunnel: boolean
  testingEndpoint: boolean
  canStart: boolean
  canTest: boolean
  setSelectedTargetId: (targetId: string) => void
  setPublicHost: (host: string) => void
  setRemotePort: (port: string) => void
  setLocalPort: (port: string) => void
  loadTargets: () => Promise<void>
  importTargets: () => Promise<void>
  startTunnel: () => Promise<void>
  stopTunnel: () => Promise<void>
  testEndpoint: () => Promise<void>
} {
  const [targets, setTargets] = useState<SshTarget[]>([])
  const [selectedTargetId, setSelectedTargetId] = useState<string>('')
  const [publicHost, setPublicHost] = useState('')
  const [remotePort, setRemotePort] = useState(DEFAULT_REMOTE_PORT)
  const [localPort, setLocalPort] = useState(DEFAULT_LOCAL_PORT)
  const [activeTunnel, setActiveTunnel] = useState<MobileReverseTunnelEntry | null>(null)
  const [loadingTargets, setLoadingTargets] = useState(false)
  const [startingTunnel, setStartingTunnel] = useState(false)
  const [stoppingTunnel, setStoppingTunnel] = useState(false)
  const [testingEndpoint, setTestingEndpoint] = useState(false)

  const selectedTarget = useMemo(
    () => targets.find((target) => target.id === selectedTargetId) ?? null,
    [selectedTargetId, targets]
  )
  const parsedRemotePort = parseMobileRemotePort(remotePort)
  const parsedLocalPort = parseMobileRemotePort(localPort)
  const canStart =
    Boolean(selectedTarget) &&
    publicHost.trim().length > 0 &&
    parsedRemotePort !== null &&
    parsedLocalPort !== null &&
    !startingTunnel &&
    !stoppingTunnel
  const canTest =
    Boolean(activeTunnel) || (publicHost.trim().length > 0 && parsedRemotePort !== null)

  const loadTargets = useCallback(async (): Promise<void> => {
    setLoadingTargets(true)
    try {
      const result = await window.api.ssh.listTargets()
      setTargets(result)
      setSelectedTargetId((current) => current || result[0]?.id || '')
    } catch {
      toast.error(
        translate(
          'auto.components.settings.MobileRemoteAccessSection.6365e72953',
          'Failed to load SSH targets'
        )
      )
    } finally {
      setLoadingTargets(false)
    }
  }, [])

  const importTargets = useCallback(async (): Promise<void> => {
    setLoadingTargets(true)
    try {
      await window.api.ssh.importConfig()
      await loadTargets()
      toast.success(
        translate(
          'auto.components.settings.MobileRemoteAccessSection.e67f547d8d',
          'SSH config imported'
        )
      )
    } catch {
      toast.error(
        translate(
          'auto.components.settings.MobileRemoteAccessSection.8fe43ce07e',
          'Failed to import SSH config'
        )
      )
      setLoadingTargets(false)
    }
  }, [loadTargets])

  const loadTunnels = useCallback(async (): Promise<void> => {
    try {
      const result = await window.api.mobileTunnel.list()
      setActiveTunnel(result.tunnels[0] ?? null)
    } catch {
      setActiveTunnel(null)
    }
  }, [])

  const loadRuntimePort = useCallback(async (): Promise<void> => {
    try {
      const result = await window.api.mobile.isWebSocketReady()
      const runtimePort = parseMobileRuntimeEndpointPort(result.endpoint)
      if (runtimePort) {
        // Why: dev/preview can fall back from 6768 when another Orca owns it;
        // the reverse tunnel must target the live runtime, not the public port.
        setLocalPort(runtimePort)
      }
    } catch {
      // Keep the documented default when the runtime endpoint is unavailable.
    }
  }, [])

  const startTunnel = useCallback(async (): Promise<void> => {
    if (!canStart || !selectedTarget || parsedRemotePort === null || parsedLocalPort === null) {
      return
    }
    setStartingTunnel(true)
    try {
      const tunnel = await window.api.mobileTunnel.start({
        targetId: selectedTarget.id,
        publicHost: publicHost.trim(),
        remotePort: parsedRemotePort,
        localPort: parsedLocalPort
      })
      setActiveTunnel(tunnel)
      onGenerateTunnelQr(tunnel.advertisedAddress)
      toast.success(
        translate(
          'auto.components.settings.MobileRemoteAccessSection.6e61d0e77b',
          'SSH tunnel started'
        )
      )
    } catch (error) {
      toast.error(
        translate(
          'auto.components.settings.MobileRemoteAccessSection.eea427c446',
          'Failed to start SSH tunnel'
        ),
        { description: error instanceof Error ? error.message : String(error) }
      )
    } finally {
      setStartingTunnel(false)
    }
  }, [canStart, onGenerateTunnelQr, parsedLocalPort, parsedRemotePort, publicHost, selectedTarget])

  const stopTunnel = useCallback(async (): Promise<void> => {
    if (!activeTunnel) {
      return
    }
    setStoppingTunnel(true)
    try {
      await window.api.mobileTunnel.stop({ id: activeTunnel.id })
      setActiveTunnel(null)
      toast.success(
        translate(
          'auto.components.settings.MobileRemoteAccessSection.995c638f50',
          'SSH tunnel stopped'
        )
      )
    } catch {
      toast.error(
        translate(
          'auto.components.settings.MobileRemoteAccessSection.f197d05635',
          'Failed to stop SSH tunnel'
        )
      )
    } finally {
      setStoppingTunnel(false)
    }
  }, [activeTunnel])

  const testEndpoint = useCallback(async (): Promise<void> => {
    const host = activeTunnel?.publicHost ?? publicHost.trim()
    const port = activeTunnel?.remotePort ?? parsedRemotePort
    if (!host || !port) {
      return
    }
    setTestingEndpoint(true)
    try {
      await window.api.mobileTunnel.testEndpoint({ host, port })
      toast.success(
        translate(
          'auto.components.settings.MobileRemoteAccessSection.c8e745b1db',
          'Endpoint is reachable'
        )
      )
    } catch (error) {
      toast.error(
        translate(
          'auto.components.settings.MobileRemoteAccessSection.a7603f1063',
          'Endpoint is not reachable'
        ),
        { description: error instanceof Error ? error.message : String(error) }
      )
    } finally {
      setTestingEndpoint(false)
    }
  }, [activeTunnel, parsedRemotePort, publicHost])

  useEffect(() => {
    void loadTargets()
    void loadTunnels()
    void loadRuntimePort()
    return window.api.mobileTunnel.onChanged(setActiveTunnel)
  }, [loadRuntimePort, loadTargets, loadTunnels])

  return {
    targets,
    selectedTargetId,
    selectedTarget,
    publicHost,
    remotePort,
    localPort,
    activeTunnel,
    loadingTargets,
    startingTunnel,
    stoppingTunnel,
    testingEndpoint,
    canStart,
    canTest,
    setSelectedTargetId,
    setPublicHost,
    setRemotePort,
    setLocalPort,
    loadTargets,
    importTargets,
    startTunnel,
    stopTunnel,
    testEndpoint
  }
}
