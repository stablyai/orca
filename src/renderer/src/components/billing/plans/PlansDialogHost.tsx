import { useState } from 'react'
import { Dialog } from '@/components/ui/dialog'
import { canManageActiveTeam } from '@/lib/orca-cloud/orca-cloud-team-role'
import { openCloudConsole } from '@/lib/orca-cloud/open-cloud-console'
import { useAppStore } from '@/store/index'
import { useOrcaBillingStatus } from '../use-orca-billing-status'
import { usePlanCatalog } from '../use-plan-catalog'
import { closePlansDialog, usePlansDialogOpen } from './plans-dialog-store'
import { PlansDialogView } from './PlansDialogView'

/**
 * The plans dialog, in front of the web console: what the team has and what billing sells, read
 * from billing (GET /v1/plans and the team's entitlement). "Continue in browser" opens the console's
 * billing page through a sign-in ticket; choosing seats and paying happen there.
 */
export function PlansDialogHost(): React.JSX.Element {
  const open = usePlansDialogOpen()
  const billing = useOrcaBillingStatus(open)
  const catalog = usePlanCatalog(open)
  const canManage = useAppStore((state) => canManageActiveTeam(state.orcaProfileAuthStatus))
  const [opening, setOpening] = useState(false)

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? undefined : closePlansDialog())}>
      {open ? (
        <PlansDialogView
          // The first read shows a skeleton; a re-read on focus keeps the last answer on screen.
          billing={billing.result}
          catalog={catalog.result}
          canManage={canManage}
          opening={opening}
          onContinue={() => {
            setOpening(true)
            void openCloudConsole('billing').finally(() => setOpening(false))
          }}
          onContactSales={(url) => void window.api.shell.openUrl(url)}
          onRetry={() => {
            billing.refresh()
            catalog.refresh()
          }}
        />
      ) : null}
    </Dialog>
  )
}
