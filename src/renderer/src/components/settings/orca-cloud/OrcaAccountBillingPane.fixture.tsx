import type { OrcaProfileAuthStatus } from '../../../../../shared/orca-profiles'
import { defineFixture } from '../../../component-fixtures/component-fixture'
import { PlanBillingView } from '../../billing/PlanBillingSection'
import {
  sampleTeam,
  sampleUsageHistory,
  sampleUsageNames
} from '../../billing/plan-billing-fixtures'
import { OrcaAccountSettingsPane } from '../accounts/orca/OrcaAccountSettingsPane'
import { SettingsSection } from '../section-layout/SettingsSection'
import { AccountBillingLayout } from './OrcaAccountBillingPane'

const BARE_BODY = 'rounded-none border-0 bg-transparent p-0 shadow-none'

const handlers = {
  loading: false,
  busy: false,
  notice: null,
  onRefresh: () => {},
  onPortal: () => {},
  onSetOverage: () => {},
  onSeePlans: () => {}
}

const signedIn: OrcaProfileAuthStatus = {
  activeProfileId: 'local-default',
  configured: true,
  state: 'connected',
  persistence: 'encrypted',
  cloud: {
    cloudProfileId: 'fixture',
    userId: 'fixture-user',
    email: 'ada@example.com',
    displayName: 'Ada Lovelace',
    activeOrgId: 'org-eval',
    activeOrgName: 'Orca Staging Eval Team',
    linkedAt: 0
  },
  capabilities: { flags: { billing: true }, refreshedAt: 0 }
}

const signedOut: OrcaProfileAuthStatus = {
  activeProfileId: 'local-default',
  configured: true,
  state: 'local',
  persistence: 'none'
}

/** Account & billing as Settings draws it: one page, account on top, Plan & billing below. */
function page(status: OrcaProfileAuthStatus, billing: React.ReactNode) {
  const title = billing ? 'Account & billing' : 'Account'
  const description = billing
    ? 'Your Orca account, plan, sandbox hours and payment.'
    : 'Your Orca account.'
  return defineFixture({
    width: 760,
    store: { orcaProfileAuthStatus: status },
    // The account part re-reads auth status on mount; answer with the same state.
    // Orca Cloud builds (the only ones with this page) have a control plane.
    setup: () => {
      Object.assign(window.api.orcaProfiles, { authStatus: () => Promise.resolve(status) })
      Object.assign(window.api, {
        cloudApi: {
          ...window.api.cloudApi,
          availability: () =>
            Promise.resolve({ status: 'ready' as const, controlPlaneUrl: 'https://cloud.example' })
        }
      })
    },
    render: () => (
      <div className="bg-background px-8 py-6">
        <SettingsSection
          id="orca-account"
          title={title}
          description={description}
          forceVisible
          bodyClassName={BARE_BODY}
        >
          <AccountBillingLayout account={<OrcaAccountSettingsPane />} billing={billing} />
        </SettingsSection>
      </div>
    )
  })
}

const usage = { status: 'ok', history: sampleUsageHistory, names: sampleUsageNames } as const

/** Owner: the account, then the plan, 30-day chart, overage controls and Manage billing. */
export const owner = page(
  signedIn,
  <PlanBillingView
    {...handlers}
    teamName="Orca Staging Eval Team"
    usage={usage}
    result={{ status: 'ok', entitlement: sampleTeam }}
  />
)

/** Member: the same page; billing shows the plan and usage, and says who can change things. */
export const member = page(
  signedIn,
  <PlanBillingView
    {...handlers}
    teamName="Orca Staging Eval Team"
    usage={{ ...usage, history: { ...sampleUsageHistory, members: null, sandboxes: null } }}
    result={{ status: 'ok', entitlement: { ...sampleTeam, canManageBilling: false } }}
  />
)

/** Signed out: only the account part, which offers sign-in; no second sign-in notice below. */
export const signedOutPage = page(signedOut, null)
