import { useEffect, useState } from 'react'
import { useAppStore } from '@/store'
import {
  resolveMobilePairingConnectionMode,
  type MobilePairingConnectionMode
} from '../../../../shared/mobile-pairing-connection-mode'

/**
 * Selected pairing path, seeded from the persisted preference and the desktop's
 * sign-in state, and re-synced when either changes. Shared by MobilePage and
 * MobilePane so the two surfaces cannot resolve the default differently.
 */
export function useMobilePairingConnectionMode(): [
  MobilePairingConnectionMode,
  React.Dispatch<React.SetStateAction<MobilePairingConnectionMode>>
] {
  const savedConnectionMode = useAppStore((s) => s.settings?.mobilePairingConnectionMode)
  const signedIn = useAppStore((s) => s.orcaProfileAuthStatus?.state === 'connected')
  const [connectionMode, setConnectionMode] = useState<MobilePairingConnectionMode>(() =>
    resolveMobilePairingConnectionMode(savedConnectionMode, { signedIn })
  )
  useEffect(() => {
    setConnectionMode(resolveMobilePairingConnectionMode(savedConnectionMode, { signedIn }))
  }, [savedConnectionMode, signedIn])
  return [connectionMode, setConnectionMode]
}
