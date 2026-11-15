import { create } from 'zustand'

/** An `orca://pair?...` link opened from outside Orca; the dialog host shows it prefilled and never auto-pairs. */
export const useRemotePairingLinkRequestStore = create<{ link: string | null }>()(() => ({
  link: null
}))

export function openRemotePairingLink(link: string): void {
  useRemotePairingLinkRequestStore.setState({ link })
}

export function clearRemotePairingLink(): void {
  useRemotePairingLinkRequestStore.setState({ link: null })
}
