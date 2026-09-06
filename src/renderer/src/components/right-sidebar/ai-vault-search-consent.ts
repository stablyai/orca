import { useCallback, useState } from 'react'
import { useAppStore } from '@/store'
import { resolveAiVaultSearchSettings } from '../../../../shared/ai-vault-search-settings'

// Why: "Not now" must not follow the user to the next launch, and must not come
// back when the panel remounts inside one. A module-level flag is exactly that
// lifetime; persisting it would turn a soft dismissal into a permanent one.
let dismissedThisRun = false

export type AiVaultSearchConsent = {
  enabled: boolean
  /** The consent card is the right thing to show right now. */
  showCard: boolean
  /** Dismissed this run, so the compact "Titles only" line stands in for it. */
  dismissed: boolean
  enabling: boolean
  enable: () => void
  dismiss: () => void
  reopen: () => void
}

export function useAiVaultSearchConsent(): AiVaultSearchConsent {
  const settings = useAppStore((state) => state.settings)
  const updateSettings = useAppStore((state) => state.updateSettings)
  const [dismissed, setDismissed] = useState(dismissedThisRun)
  const [enabling, setEnabling] = useState(false)
  const enabled = resolveAiVaultSearchSettings(settings).enabled

  const enable = useCallback(() => {
    setEnabling(true)
    const historyDays = resolveAiVaultSearchSettings(useAppStore.getState().settings).historyDays
    void updateSettings({ aiVaultSearch: { enabled: true, historyDays } }).finally(() =>
      setEnabling(false)
    )
  }, [updateSettings])

  const dismiss = useCallback(() => {
    dismissedThisRun = true
    setDismissed(true)
  }, [])

  const reopen = useCallback(() => {
    dismissedThisRun = false
    setDismissed(false)
  }, [])

  return {
    enabled,
    showCard: !enabled && !dismissed,
    dismissed,
    enabling,
    enable,
    dismiss,
    reopen
  }
}

export function resetAiVaultSearchConsentDismissalForTests(): void {
  dismissedThisRun = false
}
