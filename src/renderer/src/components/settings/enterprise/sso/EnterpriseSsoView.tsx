// Settings › Enterprise: single sign-on and directory sync for a team. Fills the `singleSignOn`
// slot of EnterpriseSettingsView.
//
// Everything here is drawn from auth's answer (OrcaOrgEnterprise); the desktop decides nothing.
// Directory sync in particular renders only when the answer says `scim.available`, so turning it
// on for a customer is a server-side change and needs no new desktop build.
import { ExternalLink, KeyRound } from 'lucide-react'
import { OpenExternalSplitButton } from '@/components/open-external/OpenExternalSplitButton'
import type { ExternalLinkSource } from '@/components/open-external/copy-external-link'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { useIntlLocale, useTranslate, type Translate } from '@/i18n/use-translate'
import type { OrcaOrgEnterprise } from '../../../../../../shared/orca-org-enterprise'
import { CloudApiSkeletonRows } from '../../cloud-api/cloud-api-parts'
import { SettingsGroup } from '../../section-layout/SettingsGroup'
import { EnterpriseUpsell, EnterpriseUpsellLine, type EnterpriseContact } from '../EnterpriseUpsell'
import { EnterpriseSsoDomains, type EnterpriseSsoDomainsProps } from './EnterpriseSsoDomains'
import { EnterpriseDirectorySync } from './EnterpriseDirectorySync'
import { GroupTitle, Row } from './enterprise-sso-parts'

export type EnterpriseSsoState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ok'; enterprise: OrcaOrgEnterprise }

export type EnterpriseSsoViewProps = {
  state: EnterpriseSsoState
  contact: EnterpriseContact
  now: number
  /** The page banner already carries Contact sales: the locked block shows a plain line. */
  underBanner?: boolean
  /** Why the setup page could not be opened, shown under the button. */
  setupNotice: string | null
  /** Mints the setup link; resolves null after explaining (setupNotice) why there is none. */
  setupLink: ExternalLinkSource
  onOpenSetup: () => void
  onOpenUrl: (url: string) => void
  onContactSales: (url: string) => void
  onRetry: () => void
  domains: Omit<EnterpriseSsoDomainsProps, 'domains' | 'canEdit'>
}

function SsoTitle(): React.JSX.Element {
  const t = useTranslate()
  return (
    <GroupTitle icon={KeyRound}>{t('settings.enterprise.sso.title', 'Single sign-on')}</GroupTitle>
  )
}

function ssoStatusCopy(
  enterprise: OrcaOrgEnterprise,
  t: Translate
): { badge: string | null; live: boolean; body: string } {
  const idp = enterprise.sso.idp
  switch (enterprise.sso.status) {
    case 'live':
      return {
        badge: t('settings.enterprise.sso.status.on', 'On'),
        live: true,
        body: idp
          ? t('settings.enterprise.sso.status.onWith', 'Your team signs in with {{idp}}.', { idp })
          : t(
              'settings.enterprise.sso.status.onBody',
              'Your team signs in with your identity provider.'
            )
      }
    case 'test':
      return {
        badge: t('settings.enterprise.sso.status.testing', 'Testing'),
        live: false,
        body: t(
          'settings.enterprise.sso.status.testingBody',
          'Your connection is set up but not live. Finish testing it on the setup page to turn it on.'
        )
      }
    case 'allowed':
    case 'off':
      return {
        badge: null,
        live: false,
        body: t(
          'settings.enterprise.sso.status.offBody',
          'Connect your identity provider over SAML or OIDC so your team signs in with it.'
        )
      }
  }
}

function SingleSignOn(
  props: EnterpriseSsoViewProps & { enterprise: OrcaOrgEnterprise }
): React.JSX.Element {
  const t = useTranslate()
  const locale = useIntlLocale()
  const { enterprise, contact } = props
  const { sso, canManage } = enterprise
  const status = ssoStatusCopy(enterprise, t)
  const configured = sso.status === 'test' || sso.status === 'live'
  // A team whose plan lapsed keeps its connection and the requirement; it can no longer change it.
  const canChange = canManage && sso.entitled
  return (
    <SettingsGroup title={<SsoTitle />}>
      <Row
        title={
          <>
            {t('settings.enterprise.sso.connection', 'Identity provider')}
            {status.badge ? (
              <Badge variant={status.live ? 'statusSuccess' : 'tag'}>{status.badge}</Badge>
            ) : null}
          </>
        }
        body={status.body}
      >
        {canChange ? (
          <OpenExternalSplitButton
            variant="outline"
            size="sm"
            link={props.setupLink}
            onClick={props.onOpenSetup}
          >
            {configured
              ? t('settings.enterprise.sso.manage', 'Manage')
              : t('settings.enterprise.sso.setUp', 'Set up SSO')}
            <ExternalLink />
          </OpenExternalSplitButton>
        ) : null}
      </Row>
      {canChange ? (
        <p data-settings-row="" className="py-3 text-xs text-muted-foreground text-pretty">
          {props.setupNotice ??
            t(
              'settings.enterprise.sso.linkWarning',
              'The setup link works without signing in and expires in 1 hour. Only share it with the person who manages your identity provider.'
            )}
        </p>
      ) : !canManage ? (
        <p data-settings-row="" className="py-3 text-xs text-muted-foreground text-pretty">
          {t('settings.enterprise.sso.ownersOnly', 'Only a team owner can change single sign-on.')}
        </p>
      ) : (
        <p data-settings-row="" className="py-3 text-xs text-muted-foreground text-pretty">
          {t(
            'settings.enterprise.sso.lapsed',
            'Single sign-on stays on, but your plan no longer includes changing it. Contact us to make changes.'
          )}
        </p>
      )}
      <Row
        title={t('settings.enterprise.sso.require', 'Require SSO')}
        body={
          sso.required
            ? sso.ownerSignedInWithSso
              ? t(
                  'settings.enterprise.sso.requiredBody',
                  'Every member signs in with SSO. Other sign-in methods are turned off for your team.'
                )
              : t(
                  'settings.enterprise.sso.requiredOwnersBody',
                  'Members sign in with SSO. Owners can still sign in another way until one owner has signed in with SSO.'
                )
            : t(
                'settings.enterprise.sso.requireOffBody',
                'Once SSO is on, every member must sign in with it. This can’t be turned off separately.'
              )
        }
      >
        <span className="text-xs font-medium text-muted-foreground">
          {sso.required
            ? t('settings.enterprise.sso.requiredValue', 'Required')
            : t('settings.enterprise.sso.notRequiredValue', 'Not yet')}
        </span>
      </Row>
      {sso.required && sso.sessionsEndAt !== null && sso.sessionsEndAt > props.now ? (
        <p data-settings-row="" className="py-3 text-xs text-muted-foreground text-pretty">
          {t(
            'settings.enterprise.sso.sessionsEndOn',
            'Sign-ins made before SSO was turned on end on {{date}} at {{time}}. Members then sign in again with SSO.',
            {
              date: new Intl.DateTimeFormat(locale, { dateStyle: 'medium' }).format(
                sso.sessionsEndAt
              ),
              time: new Intl.DateTimeFormat(locale, { timeStyle: 'short' }).format(
                sso.sessionsEndAt
              )
            }
          )}
        </p>
      ) : null}
      {canChange || sso.domains.length > 0 ? (
        <EnterpriseSsoDomains {...props.domains} domains={sso.domains} canEdit={canChange} />
      ) : null}
      {canManage && !sso.entitled ? (
        <Row
          title={t('settings.enterprise.sso.lapsedTitle', 'Need to change single sign-on?')}
          body={t('settings.enterprise.sso.lapsedBody', 'Talk to us about your plan.')}
        >
          <OpenExternalSplitButton
            variant="outline"
            size="sm"
            // Copy link is for sign-in surfaces only: a contact page is a plain button.
            link={null}
            onClick={() => props.onContactSales(contact.contactUrl)}
          >
            {t('settings.enterprise.contactUs', 'Contact us')}
            <ExternalLink />
          </OpenExternalSplitButton>
        </Row>
      ) : null}
    </SettingsGroup>
  )
}

export function EnterpriseSsoView(props: EnterpriseSsoViewProps): React.JSX.Element | null {
  const t = useTranslate()
  const { state, contact } = props
  if (state.status === 'loading') {
    return (
      <SettingsGroup title={<SsoTitle />}>
        <CloudApiSkeletonRows
          rows={2}
          label={t('settings.enterprise.sso.loading', 'Loading single sign-on')}
        />
      </SettingsGroup>
    )
  }
  if (state.status === 'error') {
    return (
      <SettingsGroup title={<SsoTitle />}>
        <Row
          title={t('settings.enterprise.sso.loadFailed', 'Couldn’t load single sign-on')}
          body={state.message}
        >
          <Button type="button" variant="outline" size="sm" onClick={props.onRetry}>
            {t('settings.enterprise.sso.retry', 'Try again')}
          </Button>
        </Row>
      </SettingsGroup>
    )
  }
  const { enterprise } = state
  const { sso, scim } = enterprise
  // Never had it and the plan does not include it: the shared locked state. A team that already
  // has a connection always sees it, plan or not.
  const locked = !sso.entitled && (sso.status === 'off' || sso.status === 'allowed')
  const upsellBody = t(
    'settings.enterprise.sso.upsellBodySso',
    'Sign in with your identity provider over SAML or OIDC, and require it for everyone on your team.'
  )
  return (
    <div className="space-y-8">
      {locked ? (
        <SettingsGroup title={<SsoTitle />}>
          {props.underBanner ? (
            <EnterpriseUpsellLine>{upsellBody}</EnterpriseUpsellLine>
          ) : (
            <EnterpriseUpsell
              title={t(
                'settings.enterprise.sso.upsellTitle',
                'Single sign-on is part of {{plan}}',
                {
                  plan: contact.planName
                }
              )}
              body={upsellBody}
              contact={contact}
              onContactSales={props.onContactSales}
            />
          )}
        </SettingsGroup>
      ) : (
        <SingleSignOn {...props} enterprise={enterprise} />
      )}
      {scim.available ? (
        <EnterpriseDirectorySync
          enterprise={enterprise}
          now={props.now}
          onOpenUrl={props.onOpenUrl}
        />
      ) : null}
    </div>
  )
}
