import { useCallback, useEffect, useState } from 'react'
import { useMountedRef } from '@/hooks/useMountedRef'
import {
  clearGeneratedRuntimePairingLink,
  runtimePairingLinkCache
} from './runtime-pairing-link-state'

function readGeneratedLink() {
  const {
    generatedAddress,
    runtimePairingUrl,
    webClientUrl,
    runtimePairingDeviceId,
    inviteExpiresAt
  } = runtimePairingLinkCache
  return {
    generatedAddress,
    runtimePairingUrl,
    webClientUrl,
    runtimePairingDeviceId,
    inviteExpiresAt
  }
}

export function useRuntimePairingLinkState() {
  const [link, setLink] = useState(readGeneratedLink)
  const mountedRef = useMountedRef()
  const clearGeneratedUrls = useCallback(() => {
    clearGeneratedRuntimePairingLink()
    if (mountedRef.current) {
      setLink(readGeneratedLink())
    }
  }, [mountedRef])
  const expireIfNeeded = useCallback(() => {
    if (link.inviteExpiresAt !== null && link.inviteExpiresAt <= Date.now()) {
      clearGeneratedUrls()
      return true
    }
    return false
  }, [link.inviteExpiresAt, clearGeneratedUrls])

  useEffect(() => {
    if (link.inviteExpiresAt === null || expireIfNeeded()) {
      return
    }
    const timer = window.setTimeout(expireIfNeeded, link.inviteExpiresAt - Date.now())
    return () => window.clearTimeout(timer)
  }, [link.inviteExpiresAt, expireIfNeeded])

  return {
    link,
    clearGeneratedUrls,
    expireIfNeeded,
    refreshGeneratedUrls: () => setLink(readGeneratedLink())
  }
}
