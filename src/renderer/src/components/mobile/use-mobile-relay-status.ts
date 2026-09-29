import { useEffect, useState } from 'react'
import type { MobilePairingPath } from '../../../../shared/mobile-pairing-path'
import { useAppStore } from '@/store'
import type { MobileRelayStatusDetail } from '../../../../shared/mobile-relay-status'

export function useMobileRelayStatus(): MobileRelayStatusDetail {
  const [detail, setDetail] = useState<MobileRelayStatusDetail>({ status: 'offline' })
  useEffect(() => {
    let receivedEvent = false
    let active = true
    const unsubscribe = window.api.mobile.onRelayStatusChanged?.((next) => {
      receivedEvent = true
      if (active) {
        setDetail(next)
      }
    })
    void window.api.mobile
      .getRelayStatus?.()
      .then((next) => {
        if (active && !receivedEvent) {
          setDetail(next)
        }
      })
      .catch(() => {})
    return () => {
      active = false
      unsubscribe?.()
    }
  }, [])
  return detail
}

export function useMobileRelayAuthorization(path: MobilePairingPath = 'automatic'): {
  relayAuthorized: boolean
  configurationId?: string
} {
  const signedIn = useAppStore((state) => state.orcaProfileAuthStatus?.state === 'connected')
  const { selfHosted } = useMobileRelayStatus()
  return path === 'self-hosted'
    ? {
        relayAuthorized: selfHosted?.configured === true,
        configurationId: selfHosted?.configurationId
      }
    : { relayAuthorized: signedIn }
}
