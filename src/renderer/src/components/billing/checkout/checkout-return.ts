import { useAppStore } from '@/store/index'
import {
  takeOrcaCloudCheckoutReturn,
  emitOrcaCloudCheckoutReturn
} from '@/lib/orca-cloud-after-checkout'
import { requestOrcaCloudSelectionAfterSignIn } from '@/lib/orca-cloud-select-after-sign-in'
import { invalidateOrcaCloudBilling } from '@/components/new-workspace/orca-cloud-billing-cache'
import { ORCA_CLOUD_RECIPE_ID } from '../../../../../shared/hosted-sandbox/orca-cloud-recipe-id'
import { closePlansPage } from '../plans/plans-page-store'
import { closeTeamPage, openTeamPage } from '../team/team-page-store'

/**
 * A paid Checkout closes the plans page and goes back to the work that hit the wall: the open
 * composer with Orca Cloud picked, or the refused create, retried. Without an intent it lands on
 * the Team page's "You're on Team" confirmation.
 */
export function returnAfterPaidCheckout(paidSeats: number): void {
  closePlansPage()
  const store = useAppStore.getState()
  const target = takeOrcaCloudCheckoutReturn({
    composerOpen: store.activeModal === 'new-workspace-composer',
    hasCreation: (creationId) => Boolean(store.pendingWorktreeCreations[creationId])
  })
  if (target.kind === 'team-page') {
    openTeamPage({ kind: 'checkout-success', seats: paidSeats })
    return
  }
  closeTeamPage()
  // The Run-on row cached "no plan"; read the new entitlement now so it shows hours, not Upgrade.
  invalidateOrcaCloudBilling()
  switch (target.kind) {
    case 'retry':
      // Lazy: the creation flow's import graph is heavy and billing never needs it otherwise.
      void import('@/lib/workspace/creation/worktree-creation-flow').then(
        ({ retryBackgroundWorktreeCreation }) => retryBackgroundWorktreeCreation(target.creationId)
      )
      return
    case 'select-in-composer':
      // The composer's recipe list reloads and consumes this, as it does after signing in.
      requestOrcaCloudSelectionAfterSignIn()
      emitOrcaCloudCheckoutReturn()
      return
    case 'open-composer':
      store.openModal('new-workspace-composer', {
        initialEphemeralVmRecipeId: ORCA_CLOUD_RECIPE_ID,
        telemetrySource: 'unknown'
      })
  }
}
