import { defineFixture } from '../../../component-fixtures/component-fixture'
import { OrcaCloudSetupPanel } from '@/components/new-workspace/run-on/OrcaCloudSetupPanel'
import type { CloudSetupStep } from '@/components/new-workspace/run-on/cloud-start-model'
import { CloudSetupBrowserTracker } from './CloudSetupBrowserTracker'
import { CloudSetupErrorNotice } from './CloudSetupErrorNotice'
import { useCloudSetupSwitchTeamFor } from './CloudSetupSwitchTeam'
import type { CloudSetupError } from './cloud-setup-errors'
import type { PlannedTeam } from './use-switch-to-planned-team'

const noop = (): void => {}
// Agent row in agent-accounts v4 wording (glossary "Agent source").
const NOT_SET_UP =
  'Claude isn’t set up for Orca Cloud yet. Set it up once in Settings → Agent accounts.'
const FROM_ACCOUNT = 'Claude · from your Orca account'
const SET_UP_ONCE = { label: 'Set up once', onClick: noop }

// A6: account and team done in the browser, GitHub in progress.
const waitingGithub: CloudSetupStep[] = [
  { id: 'account', state: 'done', detail: 'neil@acme.dev' },
  { id: 'team', state: 'done', detail: 'acme · 2 sandbox hours to try Orca Cloud' },
  { id: 'github', state: 'active', detail: 'Waiting for GitHub…' },
  { id: 'agent', state: 'optional', detail: NOT_SET_UP, action: SET_UP_ONCE }
]

// Rows derived from billing before the setup session exists: the plan row is the browser's.
const derived: CloudSetupStep[] = [
  { id: 'account', state: 'done' },
  { id: 'plan', state: 'needed', need: 'plan', canFix: true },
  { id: 'agent', state: 'optional', detail: NOT_SET_UP, action: SET_UP_ONCE }
]

// Signed in, nothing finished yet: the account step is in the browser.
const signingIn: CloudSetupStep[] = [
  { id: 'account', state: 'active' },
  { id: 'team', state: 'pending' },
  { id: 'github', state: 'pending' },
  { id: 'agent', state: 'optional', detail: NOT_SET_UP, action: SET_UP_ONCE }
]

function Tracker({
  steps = waitingGithub,
  error = null,
  canManageBilling = true
}: {
  steps?: CloudSetupStep[]
  error?: CloudSetupError | null
  canManageBilling?: boolean
}): React.JSX.Element {
  return (
    <div className="p-4">
      <CloudSetupBrowserTracker
        steps={steps}
        error={error}
        canManageBilling={canManageBilling}
        onCancel={noop}
        onCopyLink={noop}
        onReopen={noop}
        onErrorAction={noop}
      />
    </div>
  )
}

export const trackerWaitingGithub = defineFixture({ width: 560, render: () => <Tracker /> })
export const trackerSigningIn = defineFixture({
  width: 560,
  render: () => <Tracker steps={signingIn} />
})
export const trackerDerivedRows = defineFixture({
  width: 560,
  render: () => <Tracker steps={derived} />
})

const stopped: CloudSetupStep[] = [
  { id: 'account', state: 'done', detail: 'neil@acme.dev' },
  { id: 'team', state: 'done', detail: 'acme' },
  { id: 'plan', state: 'needed', need: 'plan', canFix: true },
  { id: 'agent', state: 'optional', detail: NOT_SET_UP, action: SET_UP_ONCE }
]

export const trackerTimedOut = defineFixture({
  width: 560,
  render: () => <Tracker steps={stopped} error={{ kind: 'timed_out' }} />
})
export const trackerCheckoutCanceled = defineFixture({
  width: 560,
  render: () => <Tracker steps={stopped} error={{ kind: 'checkout_canceled' }} />
})
export const trackerBankStep = defineFixture({
  width: 560,
  render: () => <Tracker steps={stopped} error={{ kind: 'bank_step' }} />
})
export const trackerTrialUnavailable = defineFixture({
  width: 560,
  render: () => <Tracker steps={stopped} error={{ kind: 'trial_unavailable' }} />
})
export const trackerTrialUnavailableMember = defineFixture({
  width: 560,
  render: () => (
    <Tracker steps={stopped} error={{ kind: 'trial_unavailable' }} canManageBilling={false} />
  )
})
export const trackerTeamCreateFailed = defineFixture({
  width: 560,
  render: () => (
    <Tracker
      steps={[
        { id: 'account', state: 'done', detail: 'neil@acme.dev' },
        { id: 'team', state: 'failed' },
        { id: 'github', state: 'pending' }
      ]}
      error={{ kind: 'team_create_failed' }}
    />
  )
})
export const trackerWrongAccount = defineFixture({
  width: 560,
  render: () => (
    <Tracker
      steps={[
        { id: 'account', state: 'failed', detail: 'sam@other.dev' },
        { id: 'team', state: 'pending' },
        { id: 'github', state: 'pending' }
      ]}
      error={{ kind: 'wrong_account', detail: 'sam@other.dev', teamName: 'acme' }}
    />
  )
})

// X1: every setup error notice, as in the spec's sheet.
export const x1SetupErrors = defineFixture({
  width: 560,
  render: () => (
    <div className="flex flex-col gap-2 p-4">
      {(
        [
          { kind: 'timed_out' },
          { kind: 'checkout_canceled' },
          { kind: 'bank_step' },
          { kind: 'trial_unavailable' },
          { kind: 'team_create_failed' },
          { kind: 'wrong_account', detail: 'sam@other.dev', teamName: 'acme' }
        ] satisfies CloudSetupError[]
      ).map((error) => (
        <CloudSetupErrorNotice key={error.kind} error={error} onAction={noop} />
      ))}
      <CloudSetupErrorNotice
        error={{ kind: 'trial_unavailable' }}
        canManageBilling={false}
        onAction={noop}
      />
    </div>
  )
})

// B1: an owner whose team never had a trial: the trial is the first plan, no trip.
export const b1OwnerTrialAvailable = defineFixture({
  width: 560,
  render: () => (
    <div className="p-4">
      <OrcaCloudSetupPanel
        steps={[
          {
            id: 'plan',
            state: 'done',
            detail: '2 sandbox hours to try Orca Cloud · no card needed'
          },
          { id: 'github', state: 'done', detail: 'acme/web' },
          { id: 'agent', state: 'done', detail: FROM_ACCOUNT }
        ]}
      />
    </div>
  )
})

function SwitchTeamPanel({ teams }: { teams: PlannedTeam[] }): React.JSX.Element {
  const b2 = useCloudSetupSwitchTeamFor(teams, noop)
  return (
    <div className="h-[260px] p-4">
      <OrcaCloudSetupPanel
        steps={[
          { id: 'account', state: 'done', detail: 'neil@acme.dev · Personal account' },
          ...(b2 ? [b2.step] : []),
          { id: 'github', state: 'done', detail: 'acme/web' }
        ]}
        rowActions={b2 ? { team: b2.action } : undefined}
      />
    </div>
  )
}

// B2: personal account, but a team the user is on has a plan: switch instead of buying.
export const b2SwitchTeam = defineFixture({
  width: 560,
  render: () => <SwitchTeamPanel teams={[{ orgId: 'org_acme', name: 'acme', planLabel: 'Team' }]} />
})
export const b2SwitchTeamMenu = defineFixture({
  width: 560,
  render: () => (
    <SwitchTeamPanel
      teams={[
        { orgId: 'org_acme', name: 'acme', planLabel: 'Team' },
        { orgId: 'org_side', name: 'side-project', planLabel: 'Team' }
      ]}
    />
  )
})
