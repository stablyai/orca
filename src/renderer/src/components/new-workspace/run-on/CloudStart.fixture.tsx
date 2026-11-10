// "Start in Orca Cloud" composer frames from cloud-start-onboarding spec v2: E1, A1, A6, A7, T1,
// T2, E, X2, the panel's GitHub rows D1–D3 and D4's GitHub-only projects. Entry points and T4 are in CloudStartSurfaces.
import { defineFixture } from '../../../component-fixtures/component-fixture'
import type { OrcaCloudRunTargetAccess } from '../orca-cloud-run-target-access'
import type { CloudSetupStep } from './cloud-start-model'
import { ComposerPreview } from './cloud-start-preview-fixture'

const setup = (): void => {
  window.api.agentApiKeys = undefined
  window.api.cloudSecrets = undefined
  window.api.cloudWorkspaces = { ...window.api.cloudWorkspaces, available: async () => true }
}
const entitled: OrcaCloudRunTargetAccess = { state: 'entitled', remainingSeconds: 41 * 3600 }
const trial = (hours: number, canManageBilling = true): OrcaCloudRunTargetAccess => ({
  state: 'entitled',
  remainingSeconds: hours * 3600,
  trial: true,
  canManageBilling
})
const githubDone: CloudSetupStep = {
  id: 'github',
  state: 'done',
  label: 'GitHub access',
  status: 'Done',
  detail: 'acme/web'
}
const githubNeeded: CloudSetupStep = {
  id: 'github',
  state: 'needed',
  need: 'github',
  canFix: true,
  label: 'GitHub access',
  status: 'Needed',
  detail: 'Orca Cloud can’t reach acme/billing yet.',
  note: 'It clones your code from GitHub. Give access to this repository once.'
}

/** E1: Run on as segments, this computer picked; the machine moves to the hint line. */
export const e1RunOnDefault = defineFixture({
  width: 560,
  setup,
  render: () => <ComposerPreview availability="offered" access={entitled} cloudSelected={false} />
})
/** E1 with "⋯" open: today's host picker without the Orca Cloud row. */
export const e1MorePlaces = defineFixture({
  ...e1RunOnDefault,
  interact: (frame) => {
    frame.querySelector<HTMLButtonElement>('[aria-label="More places to run"]')?.click()
  }
})
/** A1: Orca Cloud picked while signed out; trial included, one setup trip. */
export const a1SignedOut = defineFixture({
  width: 560,
  setup,
  render: () => (
    <ComposerPreview
      availability="needs-sign-in"
      access={{ state: 'signed-out' }}
      cloudSelected
      github={{
        ...githubNeeded,
        detail: 'acme/web is private. Orca Cloud needs access to clone it.',
        note: undefined
      }}
    />
  )
})
/** B1: signed in, the team can still get its trial. */
export const b1TrialAvailable = defineFixture({
  width: 560,
  setup,
  render: () => (
    <ComposerPreview
      availability="offered"
      access={{ state: 'no-plan', lapsed: false, canManageBilling: true, trialOfferSeconds: 7200 }}
      cloudSelected
      github={githubDone}
    />
  )
})
/** A6: Finish in your browser; each step ticks in place. */
export const a6FinishInBrowser = defineFixture({
  width: 560,
  setup,
  render: () => (
    <ComposerPreview
      availability="offered"
      access={entitled}
      cloudSelected
      steps={[
        { id: 'account', state: 'done', detail: 'neil@acme.dev' },
        { id: 'team', state: 'done', detail: 'acme · 2 sandbox hours to try Orca Cloud' },
        { id: 'github', state: 'active', status: 'In browser', detail: 'Waiting for GitHub…' },
        { id: 'agent', state: 'optional' }
      ]}
    />
  )
})
/** A7: everything done; "All set", then the composer starts by itself. */
export const a7AllSet = defineFixture({
  width: 560,
  setup,
  render: () => (
    <ComposerPreview
      availability="offered"
      access={trial(2)}
      cloudSelected
      allSet
      steps={[
        { id: 'account', state: 'done', detail: 'neil@acme.dev' },
        { id: 'plan', state: 'done', label: 'Trial', detail: 'acme · 2 sandbox hours left' },
        { ...githubDone }
      ]}
    />
  )
})
/** T1: trial hours in the composer hint. */
export const t1TrialHint = defineFixture({
  width: 560,
  setup,
  render: () => <ComposerPreview availability="offered" access={trial(1.4)} cloudSelected />
})
/** T1 under half an hour: warning, with Choose plan for owners. */
export const t1TrialLow = defineFixture({
  width: 560,
  setup,
  render: () => <ComposerPreview availability="offered" access={trial(0.3)} cloudSelected />
})
/** T1 low, member: who can choose a plan. */
export const t1TrialLowMember = defineFixture({
  width: 560,
  setup,
  render: () => <ComposerPreview availability="offered" access={trial(0.3, false)} cloudSelected />
})
/** T2: the trial is used up at New workspace; the prompt is kept. */
export const t2TrialUsedUp = defineFixture({
  width: 560,
  setup,
  render: () => (
    <ComposerPreview
      availability="offered"
      access={{ state: 'no-plan', lapsed: false, canManageBilling: true, trialUsedUp: true }}
      cloudSelected
      prompt="Upgrade Next.js to 16 and fix the type errors."
    />
  )
})
/** C1 with the trial used up: a member can't buy, so ⌘↵ runs on this computer. */
export const t2TrialUsedUpMember = defineFixture({
  width: 560,
  setup,
  render: () => (
    <ComposerPreview
      availability="offered"
      access={{ state: 'no-plan', lapsed: false, canManageBilling: false, trialUsedUp: true }}
      cloudSelected
      prompt="Add rate limiting to the public API routes."
    />
  )
})
/** D1: GitHub checked up front; "Give access and start". */
export const d1GitHubNeeded = defineFixture({
  width: 560,
  setup,
  render: () => (
    <ComposerPreview
      availability="offered"
      access={entitled}
      cloudSelected
      github={githubNeeded}
      prompt="Write integration tests for the billing webhooks."
    />
  )
})
/** D2: waiting for an owner of the GitHub org; ⌘↵ runs on this computer. */
export const d2GitHubRequested = defineFixture({
  width: 560,
  setup,
  render: () => (
    <ComposerPreview
      availability="offered"
      access={entitled}
      cloudSelected
      github={{
        id: 'github',
        state: 'pending',
        need: 'github',
        blocksStart: true,
        label: 'GitHub access',
        status: 'Requested',
        detail: 'Waiting for an owner of acme on GitHub to approve Orca Cloud.',
        note: 'GitHub sent them the request. This workspace starts once they approve, if Orca is open.'
      }}
    />
  )
})
/** D3: the project isn't on GitHub; outranks account and plan rows. */
export const d3NotOnGitHub = defineFixture({
  width: 560,
  setup,
  render: () => (
    <ComposerPreview
      availability="offered"
      access={entitled}
      cloudSelected
      github={{
        id: 'github',
        state: 'failed',
        need: 'github',
        blocksStart: true,
        label: 'GitHub repository',
        status: '',
        detail: 'Orca Cloud starts from a GitHub repository.',
        note: 'Push this project to GitHub, or pick a repository Orca Cloud can reach from Project.',
        action: { label: 'How to push', onClick: () => {} }
      }}
    />
  )
})
const cloudRepos = [
  { fullName: 'acme/billing', url: 'https://github.com/acme/billing', private: true },
  { fullName: 'acme/infra', url: 'https://github.com/acme/infra', private: true },
  { fullName: 'acme/docs', url: 'https://github.com/acme/docs', private: false }
]
/** D4: Orca Cloud picked; the Project picker adds GitHub repositories with no clone here. */
export const d4GitHubProjects = defineFixture({
  width: 560,
  setup,
  render: () => (
    <ComposerPreview
      availability="offered"
      access={entitled}
      cloudSelected
      cloudRepos={cloudRepos}
    />
  ),
  interact: async (frame) => {
    frame.querySelector<HTMLButtonElement>('[aria-label="Browse projects"]')?.click()
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
})
/** D4 picked: the repository stands in for the project; This computer says why it can't run it. */
export const d4GitHubProjectPicked = defineFixture({
  width: 560,
  setup,
  render: () => (
    <ComposerPreview
      availability="offered"
      access={entitled}
      cloudSelected
      cloudRepos={cloudRepos}
      pickedCloudRepo="acme/billing"
      prompt="Write integration tests for the billing webhooks."
    />
  )
})
/** E: returning, entitled; remembered Orca Cloud, no panel, "Start in Orca Cloud". */
export const eReturning = defineFixture({
  width: 560,
  setup,
  render: () => (
    <ComposerPreview
      availability="offered"
      access={entitled}
      cloudSelected
      github={githubDone}
      steps={[{ id: 'account', state: 'done' }, { id: 'plan', state: 'done' }, githubDone]}
      prompt="Bump eslint to v10 and fix the new warnings."
    />
  )
})
/** X2: Orca Cloud can't be reached; the segment stays, disabled, with the reason. */
export const x2Unreachable = defineFixture({
  width: 560,
  setup,
  render: () => (
    <ComposerPreview
      availability="unreachable"
      access={{ state: 'unknown' }}
      cloudSelected={false}
    />
  ),
  interact: async (frame) => {
    frame
      .querySelector('[role="radio"][aria-disabled="true"]')
      ?.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, pointerType: 'mouse' }))
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
})
