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
import { EnterpriseMfaPolicy } from '../../team-mfa/EnterpriseMfaPolicy'
import { EnterpriseSettingsView } from './EnterpriseSettingsView'
import { ENTERPRISE_CONTACT_URL, type EnterpriseContact } from './EnterpriseUpsell'
import { useEnterpriseAuditLog } from './use-enterprise-audit-log'
import { EnterpriseSsoView } from './sso/EnterpriseSsoView'
import { useEnterpriseSso } from './sso/use-enterprise-sso'

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
  const orgId = authStatus?.cloud?.activeOrgId ?? null
  const audit = useEnterpriseAuditLog(availability?.status === 'ready' && admin)
  const sso = useEnterpriseSso(
    authStatus?.cloud?.activeOrgId ?? null,
    availability?.status === 'ready' && admin
  )
  if (availability?.status !== 'ready' || !admin) {
    return null
  }
  // Auth says whether the single sign-on block is locked (the plan lacks it and the team has no
  // connection). Unknown while it loads or fails.
  const ssoLocked =
    sso.state.status === 'ok'
      ? !sso.state.enterprise.sso.entitled &&
        (sso.state.enterprise.sso.status === 'off' || sso.state.enterprise.sso.status === 'allowed')
      : null
  const openUrl = (url: string): void => void window.api.shell.openUrl(url)
  return (
    <EnterpriseSettingsView
      ssoIncluded={ssoLocked === null ? null : !ssoLocked}
      singleSignOn={
        <EnterpriseSsoView
          state={sso.state}
          contact={contact}
          now={sso.now}
          underBanner={ssoLocked === true && audit.log.status === 'upsell'}
          setupNotice={sso.setupNotice}
          setupLink={sso.mintSetupLink}
          onOpenSetup={sso.openSetup}
          onOpenUrl={openUrl}
          onContactSales={openUrl}
          onRetry={sso.retry}
          domains={{
            busy: sso.domainBusy,
            notice: sso.domainNotice,
            onAdd: sso.addDomain,
            onVerify: sso.verifyDomain,
            onRemove: sso.removeDomain,
            onCopy: (text) => void window.api.ui.writeClipboardText(text)
          }}
        />
      }
      policies={
        orgId ? (
          <EnterpriseMfaPolicy orgId={orgId} contact={contact} onContactSales={openUrl} />
        ) : undefined
      }
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
