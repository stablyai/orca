import { useCallback, useEffect, useRef, useState } from 'react'
import { useAppStore } from '../../../store/index'
import { refreshPairedMobileDevices } from '../paired-mobile-devices'
import {
  DEFAULT_CLOUD_SERVER,
  validateCustomCloudServer,
  type CloudServerConnectionTest,
  type CloudServerSettingsState,
  type CustomCloudServerSettings
} from '../../../../../shared/settings/custom-cloud-server'
import type { MobilePairingConnectionMode } from '../../../../../shared/remote-runtime/pairing/mobile-pairing-connection-mode'

export type CustomRelayDraft = Pick<
  CustomCloudServerSettings,
  'authServerUrl' | 'clientId' | 'relayDirectorUrl'
>

function draftFromSaved(saved: CustomCloudServerSettings): CustomRelayDraft {
  // Never offer Orca's own endpoints as a "custom" server; make the user type theirs.
  const isOrcaServer =
    saved.authServerUrl === DEFAULT_CLOUD_SERVER.authServerUrl &&
    saved.relayDirectorUrl === DEFAULT_CLOUD_SERVER.relayDirectorUrl
  return {
    authServerUrl: isOrcaServer ? '' : saved.authServerUrl,
    clientId: saved.clientId,
    relayDirectorUrl: isOrcaServer ? '' : saved.relayDirectorUrl
  }
}

export function useCustomRelayServer({
  connectionMode,
  onConnectionModeChange
}: {
  connectionMode: MobilePairingConnectionMode
  onConnectionModeChange: (mode: MobilePairingConnectionMode) => void
}) {
  const authStatus = useAppStore((s) => s.orcaProfileAuthStatus)
  const [state, setState] = useState<CloudServerSettingsState | null>(null)
  const [edited, setEdited] = useState<CustomRelayDraft | null>(null)
  const [pending, setPending] = useState<CustomCloudServerSettings | null>(null)
  const [busy, setBusy] = useState<'test' | 'save' | null>(null)
  const [result, setResult] = useState<CloudServerConnectionTest | null>(null)
  const [error, setError] = useState(false)
  const reselectModeRef = useRef<MobilePairingConnectionMode | null>(null)

  // Main broadcasts auth status after every switch, so refetch to track saves from other windows.
  useEffect(() => {
    let mounted = true
    void window.api.orcaProfiles
      .cloudServerSettings()
      .then((settings) => {
        if (mounted) {
          setState(settings)
        }
      })
      .catch(() => {
        if (mounted) {
          setError(true)
        }
      })
    return () => {
      mounted = false
    }
  }, [authStatus])

  // The sign-out a switch causes resets the mode to LAN; choosing a server is explicit consent to relay.
  // Runs on the render that clears `busy`, after the switch queued its target.
  useEffect(() => {
    const target = reselectModeRef.current
    if (target === null || busy !== null) {
      return
    }
    reselectModeRef.current = null
    if (connectionMode !== target) {
      onConnectionModeChange(target)
    }
  }, [busy, connectionMode, onConnectionModeChange])

  const saved = state?.settings ?? null
  const environmentOverrides = state?.environmentOverrides ?? false
  // Environment variables win over the saved server, so a saved custom server is not in effect then.
  const active = saved !== null && saved.enabled && !environmentOverrides
  const draft: CustomRelayDraft | null = edited ?? (saved ? draftFromSaved(saved) : null)
  const valid =
    draft && state
      ? validateCustomCloudServer({ ...draft, enabled: true }, state.allowLoopbackHttp)
      : null
  const changed =
    valid !== null &&
    saved !== null &&
    (valid.authServerUrl !== saved.authServerUrl ||
      valid.clientId !== saved.clientId ||
      valid.relayDirectorUrl !== saved.relayDirectorUrl)
  const canApply = valid !== null && !environmentOverrides && busy === null && (!active || changed)

  const update = useCallback(
    (next: Partial<CustomRelayDraft>): void => {
      setEdited((previous) => {
        const base = previous ?? (saved ? draftFromSaved(saved) : null)
        return base ? { ...base, ...next } : previous
      })
      setResult(null)
      setError(false)
    },
    [saved]
  )

  const test = useCallback(async (): Promise<void> => {
    if (!valid || busy) {
      return
    }
    setBusy('test')
    setError(false)
    setResult(null)
    try {
      setResult(await window.api.orcaProfiles.testCloudServer(valid))
    } catch {
      setError(true)
    }
    setBusy(null)
  }, [busy, valid])

  const requestSwitch = useCallback((next: CustomCloudServerSettings): void => {
    setError(false)
    setPending(next)
  }, [])

  const requestSwitchToOrcaRelay = useCallback((): void => {
    if (!saved || !state) {
      return
    }
    // Keep the user's URLs for next time; invalid saved settings fall back to Orca's defaults.
    requestSwitch(
      validateCustomCloudServer({ ...saved, enabled: false }, state.allowLoopbackHttp) ??
        DEFAULT_CLOUD_SERVER
    )
  }, [requestSwitch, saved, state])

  const cancelSwitch = useCallback((): void => {
    if (busy !== 'save') {
      setPending(null)
      setError(false)
    }
  }, [busy])

  const confirmSwitch = useCallback(async (): Promise<boolean> => {
    if (!pending || busy || !state) {
      return false
    }
    setBusy('save')
    setError(false)
    try {
      const next = await window.api.orcaProfiles.switchCloudServer(pending)
      setState({ ...state, settings: next })
      // Switching revokes relay pairings in main; the cached device list would still show them.
      void refreshPairedMobileDevices({ force: true })
      setEdited(null)
      setPending(null)
      setResult(null)
      // Reselect only once the signed-out status has reached the store that resets the mode.
      const status = await useAppStore.getState().fetchOrcaProfileAuthStatus()
      // Without a relay server to sign in to (a build with no hosted relay), LAN is the only usable path.
      reselectModeRef.current = status?.configured === false ? 'local-only' : 'automatic'
      setBusy(null)
      return true
    } catch {
      setError(true)
      setBusy(null)
      return false
    }
  }, [busy, pending, state])

  return {
    state,
    saved,
    active,
    environmentOverrides,
    draft,
    edited: edited !== null,
    valid,
    canApply,
    busy,
    result,
    error,
    pending,
    update,
    test,
    requestSwitch,
    requestSwitchToOrcaRelay,
    cancelSwitch,
    confirmSwitch
  }
}
