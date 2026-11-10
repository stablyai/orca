import { useAppStore } from '@/store/index'
import { signInAgainActionLabel } from './orca-sign-in-again'

/** The toast action that pairs with signInAgainMessage(): starts the Orca sign-in flow. */
export function signInAgainToastAction(): { label: string; onClick: () => void } {
  return {
    label: signInAgainActionLabel(),
    onClick: () => void useAppStore.getState().connectCurrentOrcaProfile()
  }
}
