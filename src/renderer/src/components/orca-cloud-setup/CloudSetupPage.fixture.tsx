import { Users } from 'lucide-react'
import { defineFixture } from '../../component-fixtures/component-fixture'
import { Button } from '@/components/ui/button'
import type { CloudSetupStep } from '@/components/new-workspace/run-on/cloud-start-model'
import { CloudSetupPage } from './CloudSetupPage'
import { cloudSetupPageModel } from './cloud-setup-page-model'
import type { CloudSetupFlow } from './use-cloud-setup-flow'

const noop = (): void => {}

// What the app's team-switch hook supplies on "Switch to your team" (its one action).
const switchTeamAction = (
  <Button size="sm" variant="outline">
    <Users aria-hidden />
    Switch to Orca Staging Eval Team
  </Button>
)

function flow(rows: CloudSetupStep[], teamSwitch = false): CloudSetupFlow {
  return {
    ...cloudSetupPageModel(rows, { teamSwitch }),
    busy: false,
    signingIn: false,
    signInDidNotFinish: false,
    cancelSignIn: noop,
    abandon: noop,
    inBrowser: false,
    error: null,
    canManageBilling: true,
    teamAction: teamSwitch ? switchTeamAction : null,
    continueInBrowser: noop,
    startTrial: noop,
    fixBilling: noop,
    installGitHub: noop,
    checkAgain: noop,
    contactUrl: null,
    reopenBrowser: noop,
    reopenLink: null,
    installGitHubLink: null
  }
}

function page(
  rows: CloudSetupStep[],
  agent: 'claude' | 'codex',
  label: string,
  teamSwitch = false,
  patch: Partial<CloudSetupFlow> = {}
) {
  return (
    <div className="h-[560px]">
      <CloudSetupPage
        flow={{ ...flow(rows, teamSwitch), ...patch }}
        projectName="Hello-World"
        prompt="Fix the flaky checkout test"
        agentLabel={label}
        agent={agent}
        onBackToComposer={noop}
        onExit={noop}
        starting={false}
      />
    </div>
  )
}

/** DS-b: signed out. The web's four steps from the first page: Account · Team · Plan · GitHub. */
export const signedOut = defineFixture({
  width: 1000,
  render: () =>
    page(
      [
        { id: 'account', state: 'needed', need: 'sign-in', canFix: true },
        { id: 'plan', state: 'pending', need: 'trial' },
        { id: 'github', state: 'needed', need: 'github', canFix: true },
        { id: 'agent', state: 'optional' }
      ],
      'claude',
      'Claude'
    )
})

/** DS-b: signed in on a trial-eligible team. Team ticks with Account; the step reads Plan, not Trial. */
export const trialPlan = defineFixture({
  width: 1000,
  render: () =>
    page(
      [
        { id: 'account', state: 'done' },
        { id: 'plan', state: 'needed', need: 'trial', canFix: true, trialSeconds: 7200 },
        { id: 'github', state: 'needed', need: 'github', canFix: true },
        { id: 'agent', state: 'optional' }
      ],
      'codex',
      'Codex'
    )
})

/** CAP-GATE-DESKTOP: the team has a plan, but Orca Cloud isn't turned on for it yet. */
export const capabilityOff = defineFixture({
  width: 1000,
  render: () =>
    page(
      [
        { id: 'account', state: 'done' },
        { id: 'plan', state: 'needed', need: 'capability' },
        { id: 'github', state: 'needed', need: 'github', canFix: true },
        { id: 'agent', state: 'optional' }
      ],
      'claude',
      'Claude',
      false,
      { contactUrl: 'https://onorca.dev/contact-sales' }
    )
})

/** DS-b: only GitHub left. NS-04 (e): the agent's glyph, muted, before its name in the header line. */
export const githubLeft = defineFixture({
  width: 1000,
  render: () =>
    page(
      [
        { id: 'account', state: 'done' },
        { id: 'plan', state: 'done' },
        { id: 'github', state: 'needed', need: 'github', canFix: true },
        { id: 'agent', state: 'optional' }
      ],
      'claude',
      'Claude'
    )
})

/** DS-b re-run repro 1: signed out, the repository check hasn't answered: GitHub shows pending. */
export const signedOutGithubUnknown = defineFixture({
  width: 1000,
  render: () =>
    page(
      [
        { id: 'account', state: 'needed', need: 'sign-in', canFix: true },
        { id: 'plan', state: 'pending', need: 'trial' },
        { id: 'agent', state: 'optional' }
      ],
      'claude',
      'Claude'
    )
})

/** DS-b re-run repro 2: a member with no active team ("Switch to your team"): Plan shows pending. */
export const teamSwitchPlanUnknown = defineFixture({
  width: 1000,
  render: () =>
    page(
      [
        { id: 'account', state: 'done' },
        {
          id: 'team',
          state: 'needed',
          detail:
            'Cloud workspaces belong to a team. Orca Staging Eval Team has a Team plan. Switch to start this workspace there.'
        },
        { id: 'github', state: 'needed', need: 'github', canFix: true },
        { id: 'agent', state: 'optional' }
      ],
      'claude',
      'Claude',
      true
    )
})

/** N-10: sign-in opened in the browser; the waiting line and its actions sit flush-left too. */
export const signedOutWaitingBrowser = defineFixture({
  width: 1000,
  render: () =>
    page(
      [
        { id: 'account', state: 'needed', need: 'sign-in', canFix: true },
        { id: 'plan', state: 'pending', need: 'trial' },
        { id: 'github', state: 'needed', need: 'github', canFix: true },
        { id: 'agent', state: 'optional' }
      ],
      'claude',
      'Claude',
      false,
      { signingIn: true, inBrowser: true, reopenLink: 'https://orca.dev/setup/example' }
    )
})
