import { useState } from 'react'
import { useAppStore } from '@/store'
import {
  resolveMobilePairingConnectionMode,
  type MobilePairingConnectionMode
} from '../../../../shared/remote-runtime/pairing/mobile-pairing-connection-mode'

/** Resolve persisted mode and sign-in consistently across MobilePage and MobilePane. */
export function useMobilePairingConnectionMode(): [
  MobilePairingConnectionMode,
  React.Dispatch<React.SetStateAction<MobilePairingConnectionMode>>
] {
  const savedConnectionMode = useAppStore((s) => s.settings?.mobilePairingConnectionMode)
  const signedIn = useAppStore((s) => s.orcaProfileAuthStatus?.state === 'connected')
  const [connectionMode, setConnectionMode] = useState<MobilePairingConnectionMode>(() =>
    resolveMobilePairingConnectionMode(savedConnectionMode, { signedIn })
  )
  const [resolvedFrom, setResolvedFrom] = useState({ savedConnectionMode, signedIn })
  if (
    resolvedFrom.savedConnectionMode !== savedConnectionMode ||
    resolvedFrom.signedIn !== signedIn
  ) {
    setResolvedFrom({ savedConnectionMode, signedIn })
    setConnectionMode(resolveMobilePairingConnectionMode(savedConnectionMode, { signedIn }))
  }
  return [connectionMode, setConnectionMode]
}
