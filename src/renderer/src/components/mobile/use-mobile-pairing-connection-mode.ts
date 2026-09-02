import { useEffect, useState } from 'react'
import { useAppStore } from '@/store'
import {
  resolveMobilePairingConnectionMode,
  type MobilePairingConnectionMode
} from '../../../../shared/mobile-pairing-connection-mode'

/**
 * Selected pairing path, seeded from the persisted preference and re-synced
 * when it changes. Anywhere is the default; an explicit saved `local-only`
 * means the user already chose same-network only. Shared by MobilePage and
 * MobilePane so the two surfaces cannot resolve the saved value differently.
 */
export function useMobilePairingConnectionMode(): [
  MobilePairingConnectionMode,
  React.Dispatch<React.SetStateAction<MobilePairingConnectionMode>>
] {
  const savedConnectionMode = useAppStore((s) => s.settings?.mobilePairingConnectionMode)
  const [connectionMode, setConnectionMode] = useState<MobilePairingConnectionMode>(() =>
    resolveMobilePairingConnectionMode(savedConnectionMode)
  )
  useEffect(() => {
    setConnectionMode(resolveMobilePairingConnectionMode(savedConnectionMode))
  }, [savedConnectionMode])
  return [connectionMode, setConnectionMode]
}
