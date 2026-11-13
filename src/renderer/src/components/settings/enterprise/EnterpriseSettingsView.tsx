// Settings › Enterprise, for a team's owners and admins: single sign-on and directory sync, the
// team's sign-in policies, and the audit log. Each block shows its own controls when the team's
// plan includes it and the shared upsell (EnterpriseUpsell) when it does not.
//
// Contact sales appears once per page: a team with neither single sign-on nor the audit log gets
// one banner at the top and a plain line in each block. A team on Enterprise is never sent to sales.
//
// Slots for the blocks other owners build (pass a node; nothing renders until one is passed):
//   singleSignOn   replaces the built-in single sign-on block   (sso-scim)
//   policies       sign-in policies, e.g. "Require MFA"          (mfa)
import { ExternalLink } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useTranslate } from '@/i18n/use-translate'
import { SettingsGroup } from '../section-layout/SettingsGroup'
import { EnterpriseAuditLog, type EnterpriseAuditLogProps } from './EnterpriseAuditLog'
import { EnterpriseUpsell, EnterpriseUpsellLine } from './EnterpriseUpsell'

export const ENTERPRISE_SSO_ANCHOR = 'cloud-enterprise-sso'
export const ENTERPRISE_POLICIES_ANCHOR = 'cloud-enterprise-policies'
export const ENTERPRISE_AUDIT_LOG_ANCHOR = 'cloud-enterprise-audit-log'

export type EnterpriseSettingsViewProps = {
  audit: EnterpriseAuditLogProps
  /**
   * Whether the team's plan includes single sign-on: true, false, or null while that is not known
   * yet (the block waits rather than guess). With `singleSignOn` passed the slot draws the block,
   * and this only says whether it is showing its locked state (so the page has one Contact sales).
   */
  ssoIncluded: boolean | null
  singleSignOn?: React.ReactNode
  policies?: React.ReactNode
}

export function EnterpriseSettingsView({
  audit,
  ssoIncluded,
  singleSignOn,
  policies
}: EnterpriseSettingsViewProps): React.JSX.Element {
  const t = useTranslate()
  const { contact, onContactSales } = audit
  const ssoLocked = ssoIncluded === false
  const auditLocked = audit.log.status === 'upsell'
  // Neither: one banner carries the page's only Contact sales.
  const banner = ssoLocked && auditLocked
  const ssoUpsellBody = t(
    'settings.enterprise.sso.upsellBody',
    'Sign in with your identity provider over SAML, and add or remove teammates with SCIM.'
  )
  return (
    <div className="space-y-8">
      {banner ? (
        <SettingsGroup>
          <EnterpriseUpsell
            title={t(
              'settings.enterprise.bannerTitle',
              'Single sign-on and the audit log are part of {{plan}}',
              { plan: contact.planName }
            )}
            body={t(
              'settings.enterprise.bannerBody',
              'Talk to us about moving your team to {{plan}}.',
              { plan: contact.planName }
            )}
            contact={contact}
            onContactSales={onContactSales}
          />
        </SettingsGroup>
      ) : null}
      {singleSignOn !== undefined ? (
        <div id={ENTERPRISE_SSO_ANCHOR}>{singleSignOn}</div>
      ) : ssoIncluded === null ? null : (
        <div id={ENTERPRISE_SSO_ANCHOR}>
          <SettingsGroup
            title={t('auto.components.billing.team.ssoTitle', 'Single sign-on and provisioning')}
          >
            {ssoIncluded ? (
              // On the plan: never an upsell. We set it up with the team until they can do it here.
              <div data-settings-row="" className="flex flex-wrap items-center gap-3 py-4">
                <div className="min-w-[14rem] flex-1 space-y-0.5">
                  <p className="text-sm font-medium">
                    {t('settings.enterprise.sso.managedTitle', 'Single sign-on is set up with us')}
                  </p>
                  <p className="text-xs text-muted-foreground text-pretty">
                    {t(
                      'settings.enterprise.sso.managedBody',
                      'To set up or change single sign-on, contact us.'
                    )}
                  </p>
                </div>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => onContactSales(contact.contactUrl)}
                >
                  {t('settings.enterprise.contactUs', 'Contact us')}
                  <ExternalLink />
                </Button>
              </div>
            ) : banner ? (
              <EnterpriseUpsellLine>{ssoUpsellBody}</EnterpriseUpsellLine>
            ) : (
              <EnterpriseUpsell
                title={t(
                  'settings.enterprise.sso.upsellTitle',
                  'Single sign-on is part of {{plan}}',
                  { plan: contact.planName }
                )}
                body={ssoUpsellBody}
                contact={contact}
                onContactSales={onContactSales}
              />
            )}
          </SettingsGroup>
        </div>
      )}
      {policies ? <div id={ENTERPRISE_POLICIES_ANCHOR}>{policies}</div> : null}
      <div id={ENTERPRISE_AUDIT_LOG_ANCHOR}>
        <EnterpriseAuditLog {...audit} upsellButton={!banner} />
      </div>
    </div>
  )
}
