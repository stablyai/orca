// "Start in Orca Cloud" at the real modal's width (sm:max-w-lg, ~448px of content) with its
// "Create more" switch, where np4-e2e saw the primary button overflow the dialog's right edge.
// Also the setup session's plan row (no raw "subscription") and the plan + GitHub subtitle.
import { defineFixture } from '../../../component-fixtures/component-fixture'
import type { OrcaCloudRunTargetAccess } from '../orca-cloud-run-target-access'
import type { CloudSetupStep } from './cloud-start-model'
import { ComposerPreview } from './cloud-start-preview-fixture'

const setup = (): void => {
  window.api.agentApiKeys = undefined
  window.api.cloudSecrets = undefined
  window.api.orcaCloudAgents = undefined
  window.api.cloudWorkspaces = { ...window.api.cloudWorkspaces, available: async () => true }
}
const CARD_WIDTH = 480
const noPlan: OrcaCloudRunTargetAccess = {
  state: 'no-plan',
  lapsed: false,
  canManageBilling: true
}
const githubNeeded: CloudSetupStep = {
  id: 'github',
  state: 'needed',
  need: 'github',
  canFix: true,
  label: 'GitHub access',
  status: 'Needed',
  detail: 'Orca Cloud can’t reach nwparker/orca-sandbox-push-test yet.',
  note: 'It clones your code from GitHub. Give access to this repository once.'
}

/** Signed out at the modal's width: "Create more", "Use this computer instead", "Set up and start". */
export const modalSignedOut = defineFixture({
  width: CARD_WIDTH + 40,
  setup,
  render: () => (
    <ComposerPreview
      availability="needs-sign-in"
      access={{ state: 'signed-out' }}
      cloudSelected
      showCreateMultiple
      width={CARD_WIDTH}
    />
  )
})

/** Only GitHub is missing: the longer "Give access and start" at the modal's width. */
export const modalGiveAccess = defineFixture({
  width: CARD_WIDTH + 40,
  setup,
  render: () => (
    <ComposerPreview
      availability="offered"
      access={{ state: 'entitled', remainingSeconds: 41 * 3600 }}
      cloudSelected
      github={githubNeeded}
      showCreateMultiple
      width={CARD_WIDTH}
    />
  )
})

/** No plan and no GitHub access: the subtitle names both parts of the one browser visit. */
export const modalPlanAndGitHub = defineFixture({
  width: CARD_WIDTH + 40,
  setup,
  render: () => (
    <ComposerPreview
      availability="offered"
      access={noPlan}
      cloudSelected
      github={githubNeeded}
      showCreateMultiple
      width={CARD_WIDTH}
    />
  )
})

/** A setup session after Checkout: Team plan done with no raw "subscription" under it. */
export const sessionPlanDone = defineFixture({
  width: CARD_WIDTH + 40,
  setup,
  render: () => (
    <ComposerPreview
      availability="offered"
      access={noPlan}
      cloudSelected
      showCreateMultiple
      width={CARD_WIDTH}
      steps={[
        { id: 'account', state: 'done' },
        { id: 'team', state: 'done' },
        { id: 'plan', state: 'done', detail: 'subscription' },
        { id: 'github', state: 'active' },
        { id: 'agent', state: 'optional' }
      ]}
    />
  )
})

/** A setup session mid-Checkout, with an owner's GitHub approval pending: codes read as words. */
export const sessionCheckoutAndRequested = defineFixture({
  width: CARD_WIDTH + 40,
  setup,
  render: () => (
    <ComposerPreview
      availability="offered"
      access={noPlan}
      cloudSelected
      width={CARD_WIDTH}
      steps={[
        { id: 'account', state: 'done' },
        { id: 'team', state: 'done' },
        { id: 'plan', state: 'active', detail: 'checkout' },
        { id: 'github', state: 'pending', detail: 'requested' },
        { id: 'agent', state: 'optional' }
      ]}
    />
  )
})
