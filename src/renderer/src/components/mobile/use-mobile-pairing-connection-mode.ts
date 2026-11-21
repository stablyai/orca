import { useState } from 'react'
import { useAppStore } from '@/store'
import { useOrcaTeamFeatureBlocked } from '@/lib/orca-team-policy'
import { ORCA_CLOUD_TEAM_POLICY_FLAGS } from '../../../../shared/orca-profiles/orca-cloud-team-policy'
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
  const relayBlocked = useOrcaTeamFeatureBlocked(ORCA_CLOUD_TEAM_POLICY_FLAGS.mobileRelay)
  const [connectionMode, setConnectionMode] = useState<MobilePairingConnectionMode>(() =>
    resolveMobilePairingConnectionMode(savedConnectionMode, { signedIn })
  )
  const [resolvedFrom, setResolvedFrom] = useState({ savedConnectionMode, signedIn })
  if (
    resolvedFrom.savedConnectionMode !== savedConnectionMode ||
    resolvedFrom.signedIn !== signedIn
  ) {
    // A saved-mode change with sign-in unchanged is a live pick (here or another window), so honor Relay even signed out.
    const livePick =
      resolvedFrom.signedIn === signedIn && resolvedFrom.savedConnectionMode !== undefined
    setResolvedFrom({ savedConnectionMode, signedIn })
    setConnectionMode(
      livePick && savedConnectionMode
        ? savedConnectionMode
        : resolveMobilePairingConnectionMode(savedConnectionMode, { signedIn })
    )
  }
  return [relayBlocked ? 'local-only' : connectionMode, setConnectionMode]
}
