import { create } from 'zustand'
import type { PluginInstallTrustPrompt } from '@/components/plugins/presentation/plugin-install-trust'

type PendingPluginInstallTrust = {
  prompt: PluginInstallTrustPrompt
  resolve: (confirmed: boolean) => void
}

/** The one install waiting for "Make sure you trust …"; the Plugins pane renders it. */
export const usePluginInstallTrustStore = create<{ pending: PendingPluginInstallTrust | null }>()(
  () => ({ pending: null })
)

/** Resolves true only on an explicit Install click; any other way out declines. */
export function confirmPluginInstallTrust(prompt: PluginInstallTrustPrompt): Promise<boolean> {
  return new Promise((resolve) => {
    // Why decline the older ask: one dialog shows, so the install it belonged to must not hang.
    usePluginInstallTrustStore.getState().pending?.resolve(false)
    usePluginInstallTrustStore.setState({ pending: { prompt, resolve } })
  })
}

export function settlePluginInstallTrust(confirmed: boolean): void {
  const { pending } = usePluginInstallTrustStore.getState()
  usePluginInstallTrustStore.setState({ pending: null })
  pending?.resolve(confirmed)
}
