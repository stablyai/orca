import { useSyncExternalStore } from 'react'
import { toast } from 'sonner'
import type { Translate } from '@/i18n/use-translate'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import type { SelectOrcaProfileOrgResult } from '../../../../../shared/orca-profiles/orca-profiles'

// The team pick in flight, shared by every switcher (the account menu's team submenu and the
// composer's "Switch to <team>" row): the menu unmounts on select, so component state would forget
// it and let a second pick race the first.
let pendingOrg: string | null = null
const pendingListeners = new Set<() => void>()

function setPendingOrg(next: string | null): void {
  pendingOrg = next
  for (const listener of pendingListeners) {
    listener()
  }
}

function subscribePending(listener: () => void): () => void {
  pendingListeners.add(listener)
  return () => pendingListeners.delete(listener)
}

/** The org being switched to (the personal account's sentinel included), or null. */
export function usePendingTeamSwitch(): string | null {
  return useSyncExternalStore(subscribePending, () => pendingOrg)
}

/** The one message for a team switch that didn't happen (null: it did). */
export function teamSwitchFailedCopy(result: SelectOrcaProfileOrgResult | null): string | null {
  if (result?.status === 'selected') {
    return null
  }
  return result?.status === 'reconnect-required'
    ? translate(
        'auto.components.sidebar.teamSwitcher.signInAgain',
        'Sign in to Orca again to switch teams.'
      )
    : translate('auto.components.sidebar.teamSwitcher.failed', 'Couldn’t switch teams. Try again.')
}

/**
 * Selects a team (or the personal account, `orgId: null`) at Orca Cloud auth, which re-scopes
 * billing, seats and the Team page, and toasts the outcome. `pendingKey` is what
 * usePendingTeamSwitch reports meanwhile. Returns false when another switch is already running.
 */
export function switchActiveTeam({
  orgId,
  label,
  pendingKey,
  t
}: {
  orgId: string | null
  label: string
  pendingKey: string
  t: Translate
}): Promise<boolean> {
  if (pendingOrg !== null) {
    return Promise.resolve(false)
  }
  setPendingOrg(pendingKey)
  return useAppStore
    .getState()
    .selectOrcaProfileOrg(orgId)
    .then((result) => {
      if (result?.status === 'selected') {
        toast.success(
          t('auto.components.sidebar.teamSwitcher.switched', 'Switched to {{value0}}', {
            value0: label
          })
        )
        return true
      }
      toast.error(teamSwitchFailedCopy(result))
      return false
    })
    .finally(() => {
      setPendingOrg(null)
    })
}
