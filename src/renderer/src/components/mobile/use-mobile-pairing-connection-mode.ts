import type { MobilePairingPath } from '../../../../shared/mobile-pairing-path'
import { useEffect, useState } from 'react'
import { useAppStore } from '@/store'
import { resolveMobilePairingConnectionMode } from '../../../../shared/mobile-pairing-connection-mode'

/**
 * Selected pairing path, seeded from the persisted preference and re-synced
 * when it changes. Anywhere is the default; an explicit saved `local-only`
 * means the user already chose same-network only. Shared by MobilePage and
 * MobilePane so the two surfaces cannot resolve the saved value differently.
 */
export function useMobilePairingConnectionMode(): [
  MobilePairingPath,
  React.Dispatch<React.SetStateAction<MobilePairingPath>>
] {
  const savedConnectionMode = useAppStore((s) => s.settings?.mobilePairingConnectionMode)
  const provider = useAppStore((s) => s.settings?.mobilePairingRelayProvider)
  const savedPath: MobilePairingPath =
    savedConnectionMode !== 'local-only' && provider === 'self-hosted'
      ? 'self-hosted'
      : resolveMobilePairingConnectionMode(savedConnectionMode)
  const [connectionMode, setConnectionMode] = useState<MobilePairingPath>(() => savedPath)
  useEffect(() => {
    setConnectionMode(savedPath)
  }, [savedPath])
  return [connectionMode, setConnectionMode]
}
