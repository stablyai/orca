import { defineFixture } from '../../../../component-fixtures/component-fixture'
import type { OrcaOrgEnterprise } from '../../../../../../shared/orca-org-enterprise'
import { SettingsSection } from '../../section-layout/SettingsSection'
import { EnterpriseSsoView, type EnterpriseSsoViewProps } from './EnterpriseSsoView'
import {
  fixtureEnterprise,
  fixtureSsoProps,
  LIVE_SSO,
  MISSING_DOMAIN,
  ok,
  PENDING_DOMAIN,
  SCIM_SETUP_URL,
  SSO_FIXTURE_NOW
} from './enterprise-sso.fixtures'

const BARE_BODY = 'rounded-none border-0 bg-transparent p-0 shadow-none'

/** The blocks as Settings › Enterprise draws them, under the page title. */
function Page(props: EnterpriseSsoViewProps): React.JSX.Element {
  return (
    <div className="bg-background px-8 py-6">
      <SettingsSection
        id="cloud-enterprise"
        title="Enterprise"
        description="Single sign-on, sign-in policies and the audit log for your team."
        forceVisible
        bodyClassName={BARE_BODY}
      >
        <EnterpriseSsoView {...props} />
      </SettingsSection>
    </div>
  )
}

const page = (
  enterprise: OrcaOrgEnterprise,
  overrides?: Partial<EnterpriseSsoViewProps>
): React.JSX.Element => <Page {...fixtureSsoProps(ok(enterprise), overrides)} />

const SCIM_ON: Partial<OrcaOrgEnterprise['scim']> = { available: true, setupUrl: SCIM_SETUP_URL }

/** A team without Enterprise: the shared locked state. Directory sync is not shown at all. */
export const notOnPlan = defineFixture({
  width: 860,
  render: () => page(fixtureEnterprise({ sso: { entitled: false } }))
})

/** An owner on Enterprise who has not started. */
export const notSetUp = defineFixture({
  width: 860,
  render: () => page(fixtureEnterprise())
})

/** The owner asked for the setup page too long after signing in. */
export const setupNeedsRecentSignIn = defineFixture({
  width: 860,
  render: () =>
    page(fixtureEnterprise(), {
      setupNotice:
        'For your team’s safety, sign out and sign in to Orca again, then open the setup page within 10 minutes.'
    })
})

/** Configured but not live, with a domain waiting for its DNS record. */
export const testingWithPendingDomain = defineFixture({
  width: 860,
  render: () =>
    page(fixtureEnterprise({ sso: { status: 'test', idp: 'Okta', domains: [PENDING_DOMAIN] } }))
})

/** The DNS check did not find the record yet. */
export const domainRecordNotFound = defineFixture({
  width: 860,
  render: () => {
    const props = fixtureSsoProps(
      ok(fixtureEnterprise({ sso: { status: 'test', idp: 'Okta', domains: [PENDING_DOMAIN] } }))
    )
    return (
      <Page
        {...props}
        domains={{
          ...props.domains,
          notice: {
            domain: 'acme.com',
            message:
              'We couldn’t find the record yet. DNS changes can take a few minutes; try again shortly.'
          }
        }}
      />
    )
  }
})

/** Live and required for everyone. SCIM is not available, so there is no directory sync block. */
export const live = defineFixture({
  width: 860,
  render: () => page(fixtureEnterprise({ sso: LIVE_SSO }))
})

/** Just went live: owners are still exempt and older sign-ins end tomorrow. One record went missing. */
export const liveGracePeriod = defineFixture({
  width: 860,
  render: () =>
    page(
      fixtureEnterprise({
        sso: {
          ...LIVE_SSO,
          ownerSignedInWithSso: false,
          sessionsEndAt: SSO_FIXTURE_NOW + 22 * 3_600_000,
          domains: [...(LIVE_SSO.domains ?? []), MISSING_DOMAIN]
        }
      })
    )
})

/** An admin: sees the state, changes nothing. */
export const liveAsAdmin = defineFixture({
  width: 860,
  render: () => page(fixtureEnterprise({ canManage: false, sso: LIVE_SSO }))
})

/** The plan lapsed: SSO stays on and required, changes stop. */
export const livePlanLapsed = defineFixture({
  width: 860,
  render: () => page(fixtureEnterprise({ sso: { ...LIVE_SSO, entitled: false } }))
})

/** Directory sync, shown because the server says it is available: SSO is not on yet. */
export const scimNeedsSso = defineFixture({
  width: 860,
  render: () =>
    page(fixtureEnterprise({ scim: { ...SCIM_ON, status: 'needs_sso', setupUrl: null } }))
})

/** SSO is live; Orca has not turned directory sync on for this team yet. */
export const scimNotTurnedOn = defineFixture({
  width: 860,
  render: () =>
    page(fixtureEnterprise({ sso: LIVE_SSO, scim: { ...SCIM_ON, status: 'not_enabled' } }))
})

/** On, nothing received from the identity provider yet. */
export const scimWaiting = defineFixture({
  width: 860,
  render: () => page(fixtureEnterprise({ sso: LIVE_SSO, scim: { ...SCIM_ON, status: 'waiting' } }))
})

/** Syncing: the last change and when it arrived. */
export const scimActive = defineFixture({
  width: 860,
  render: () =>
    page(
      fixtureEnterprise({
        sso: LIVE_SSO,
        scim: {
          ...SCIM_ON,
          status: 'active',
          lastChangeAt: SSO_FIXTURE_NOW - 3 * 60_000,
          lastChangeType: 'user.removed_from_org'
        }
      })
    )
})

export const loading = defineFixture({
  width: 860,
  render: () => <Page {...fixtureSsoProps({ status: 'loading' })} />
})

export const loadFailed = defineFixture({
  width: 860,
  render: () => (
    <Page
      {...fixtureSsoProps({
        status: 'error',
        message: 'Couldn’t reach Orca Cloud. Check your connection and try again.'
      })}
    />
  )
})
