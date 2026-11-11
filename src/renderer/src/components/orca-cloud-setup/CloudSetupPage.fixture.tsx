import { defineFixture } from '../../component-fixtures/component-fixture'
import type { CloudSetupStep } from '@/components/new-workspace/run-on/cloud-start-model'
import { CloudSetupPage } from './CloudSetupPage'
import { cloudSetupPageModel } from './cloud-setup-page-model'
import type { CloudSetupFlow } from './use-cloud-setup-flow'

const noop = (): void => {}

function flow(rows: CloudSetupStep[]): CloudSetupFlow {
  return {
    ...cloudSetupPageModel(rows),
    busy: false,
    signingIn: false,
    signInDidNotFinish: false,
    cancelSignIn: noop,
    abandon: noop,
    inBrowser: false,
    error: null,
    canManageBilling: true,
    teamAction: null,
    continueInBrowser: noop,
    startTrial: noop,
    fixBilling: noop,
    installGitHub: noop,
    checkAgain: noop,
    copyLink: null,
    reopenBrowser: noop
  }
}

function page(rows: CloudSetupStep[], agent: 'claude' | 'codex', label: string) {
  return (
    <div className="h-[560px]">
      <CloudSetupPage
        flow={flow(rows)}
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
