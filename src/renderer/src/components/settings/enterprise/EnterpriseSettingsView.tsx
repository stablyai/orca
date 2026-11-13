// Settings › Enterprise, for a team's owners and admins: single sign-on and directory sync, the
// team's sign-in policies, and the audit log. Each block shows its own controls when the team's
// plan includes it and the shared upsell (EnterpriseUpsell) when it does not.
//
// Slots for the blocks other owners build (pass a node; nothing renders until one is passed):
//   singleSignOn   replaces the SSO and directory sync upsell   (sso-scim)
//   policies       sign-in policies, e.g. "Require MFA"          (mfa)
import { useTranslate } from '@/i18n/use-translate'
import { SettingsGroup } from '../section-layout/SettingsGroup'
import { EnterpriseAuditLog, type EnterpriseAuditLogProps } from './EnterpriseAuditLog'
import { EnterpriseUpsell } from './EnterpriseUpsell'

export const ENTERPRISE_SSO_ANCHOR = 'cloud-enterprise-sso'
export const ENTERPRISE_POLICIES_ANCHOR = 'cloud-enterprise-policies'
export const ENTERPRISE_AUDIT_LOG_ANCHOR = 'cloud-enterprise-audit-log'

export type EnterpriseSettingsViewProps = {
  audit: EnterpriseAuditLogProps
  singleSignOn?: React.ReactNode
  policies?: React.ReactNode
}

export function EnterpriseSettingsView({
  audit,
  singleSignOn,
  policies
}: EnterpriseSettingsViewProps): React.JSX.Element {
  const t = useTranslate()
  return (
    <div className="space-y-8">
      <div id={ENTERPRISE_SSO_ANCHOR}>
        {singleSignOn ?? (
          <SettingsGroup
            title={t('auto.components.billing.team.ssoTitle', 'Single sign-on and provisioning')}
          >
            <EnterpriseUpsell
              title={t(
                'settings.enterprise.sso.upsellTitle',
                'Single sign-on is part of {{plan}}',
                { plan: audit.contact.planName }
              )}
              body={t(
                'settings.enterprise.sso.upsellBody',
                'Sign in with your identity provider over SAML, and add or remove teammates with SCIM.'
              )}
              contact={audit.contact}
              onContactSales={audit.onContactSales}
            />
          </SettingsGroup>
        )}
      </div>
      {policies ? <div id={ENTERPRISE_POLICIES_ANCHOR}>{policies}</div> : null}
      <div id={ENTERPRISE_AUDIT_LOG_ANCHOR}>
        <EnterpriseAuditLog {...audit} />
      </div>
    </div>
  )
}
