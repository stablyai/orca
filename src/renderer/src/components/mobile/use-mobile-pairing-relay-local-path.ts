import { useAppStore } from '@/store'

/** Relay pairing also offers a Wi‑Fi/Tailscale path unless the user turned it off. */
export function useMobilePairingRelayLocalPath(): boolean {
  return useAppStore((state) => state.settings?.mobilePairingRelayLocalPath !== false)
}
