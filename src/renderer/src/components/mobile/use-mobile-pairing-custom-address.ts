import { useMemo } from 'react'
import { useAppStore } from '@/store'
import {
  addMobilePairingCustomAddress,
  normalizeMobilePairingCustomAddress,
  normalizeMobilePairingCustomAddresses
} from '../../../../shared/mobile-pairing-custom-address'

export function useMobilePairingCustomAddress(): string | undefined {
  const savedAddress = useAppStore((state) => state.settings?.mobilePairingCustomAddress)
  return normalizeMobilePairingCustomAddress(savedAddress) ?? undefined
}

export function useMobilePairingCustomAddresses(): string[] {
  const savedAddresses = useAppStore((state) => state.settings?.mobilePairingCustomAddresses)
  const savedAddress = useAppStore((state) => state.settings?.mobilePairingCustomAddress)
  return useMemo(() => {
    const normalized = normalizeMobilePairingCustomAddresses(savedAddresses)
    return typeof savedAddress === 'string'
      ? addMobilePairingCustomAddress(normalized, savedAddress)
      : normalized
  }, [savedAddress, savedAddresses])
}
