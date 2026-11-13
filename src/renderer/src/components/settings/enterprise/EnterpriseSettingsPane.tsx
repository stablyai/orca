// Settings › Enterprise, wired to the account: who is looking, billing's Enterprise contact page,
// and the audit log's data. Shown only to a team's owners and admins (the nav hides it otherwise,
// and the control plane refuses the data regardless).
import { useEffect } from 'react'
import { useOrcaAccountKey } from '@/hooks/use-orca-account-key'
import { useOrcaCloudApiAvailability } from '@/hooks/useOrcaCloudApiAvailability'
import { activeTeamRole } from '@/lib/orca-cloud/active-team-role'
import { useAppStore } from '@/store'
import { refreshBillingSummary, useBillingState } from '../../billing/billing-summary-store'
import { canManageMembers } from '../../billing/team/team-roles'
import { EnterpriseSettingsView } from './EnterpriseSettingsView'
import { ENTERPRISE_CONTACT_URL, type EnterpriseContact } from './EnterpriseUpsell'
import { useEnterpriseAuditLog } from './use-enterprise-audit-log'

/** Billing's own name and contact page for Enterprise; the fixed page until billing has answered. */
function useEnterpriseContact(): EnterpriseContact {
  const billing = useBillingState()
  useEffect(() => {
    void refreshBillingSummary()
  }, [])
  const offer =
    billing.result?.status === 'ok' ? billing.result.entitlement.offers?.enterprise : null
  return {
    planName: offer?.label || 'Enterprise',
    contactUrl: offer?.contactUrl || ENTERPRISE_CONTACT_URL
  }
}

export function EnterpriseSettingsPane(): React.JSX.Element | null {
  // Remount on a team switch so one team's log never shows under another.
  return <EnterpriseSettingsPaneBody key={useOrcaAccountKey()} />
}

function EnterpriseSettingsPaneBody(): React.JSX.Element | null {
  const availability = useOrcaCloudApiAvailability()
  const authStatus = useAppStore((s) => s.orcaProfileAuthStatus)
  const role = activeTeamRole(authStatus)
  const admin = role !== null && canManageMembers(role)
  const contact = useEnterpriseContact()
  const audit = useEnterpriseAuditLog(availability?.status === 'ready' && admin)
  if (availability?.status !== 'ready' || !admin) {
    return null
  }
  return (
    <EnterpriseSettingsView
      // Enterprise's features come together in one plan version, so the audit log's answer says
      // which side of the plan the team is on. Unknown while it loads or fails: the block waits.
      ssoIncluded={audit.log.status === 'ok' ? true : audit.log.status === 'upsell' ? false : null}
      audit={{
        log: audit.log,
        filters: audit.filters,
        actors: audit.actors,
        exportState: audit.exportState,
        now: audit.now,
        viewerUserId: authStatus?.cloud?.userId ?? null,
        contact,
        onFilter: audit.setFilters,
        onLoadMore: audit.loadMore,
        onRetry: audit.retry,
        onExport: audit.exportCsv,
        onContactSales: (url) => void window.api.shell.openUrl(url)
      }}
    />
  )
}
