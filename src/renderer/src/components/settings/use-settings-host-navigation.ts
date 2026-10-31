import { useCallback, useState } from 'react'
import type { SettingsNavigationTarget } from '@/lib/settings-navigation-types'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'

/** A chat-scoped account view lasts only for this Settings visit. */
export function useSettingsHostNavigation(target: SettingsNavigationTarget | null) {
  const [visit, setVisit] = useState<{
    choice: RuntimeClientTarget | null
    nativeAccounts: boolean
  }>({ choice: null, nativeAccounts: false })
  const consumeSettingsNavigation = useCallback((next: SettingsNavigationTarget) => {
    setVisit((previous) => ({
      choice: next.hostScope ?? previous.choice,
      nativeAccounts: next.pane === 'accounts' && next.intent === 'native-accounts'
    }))
  }, [])
  const releaseNativeAccounts = useCallback(() => {
    // An earlier location write cannot clear a later chat-scoped visit.
    setVisit((previous) => (previous === visit ? { ...previous, nativeAccounts: false } : previous))
  }, [visit])
  const setSettingsHostChoice = useCallback((choice: RuntimeClientTarget) => {
    setVisit({ choice, nativeAccounts: false })
  }, [])
  // Pending navigation owns the first frame, before its effect clears the target.
  return {
    settingsHostChoice: target?.hostScope ?? visit.choice,
    nativeAccounts: target
      ? target.pane === 'accounts' && target.intent === 'native-accounts'
      : visit.nativeAccounts,
    consumeSettingsNavigation,
    releaseNativeAccounts,
    setSettingsHostChoice
  }
}
