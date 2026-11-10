// Orca Cloud picked on the segmented Run on, blocked by billing: the hint under Run on names the fix
// for an owner or admin, and says who can for a member (DS-15). These replace the pre-#273 dropdown
// fixtures NewWorkspaceComposerProjectSection:orcaCloudSelected* (DS-33).
import { defineFixture } from '../../../component-fixtures/component-fixture'
import type { OrcaCloudRunTargetAccess } from '../orca-cloud-run-target-access'
import { ComposerPreview } from './cloud-start-preview-fixture'

const setup = (): void => {
  window.api.agentApiKeys = undefined
  window.api.cloudSecrets = undefined
  // No agent-accounts bridge: the Agent row reads "unavailable" instead of awaiting the harness's
  // catch-all mock, which resolves to undefined (the page error DS-33 found).
  window.api.orcaCloudAgents = undefined
  window.api.cloudWorkspaces = { ...window.api.cloudWorkspaces, available: async () => true }
}

function blocked(access: OrcaCloudRunTargetAccess) {
  return defineFixture({
    width: 560,
    setup,
    render: () => <ComposerPreview availability="offered" access={access} cloudSelected />
  })
}

export const noPlanOwner = blocked({ state: 'no-plan', lapsed: false, canManageBilling: true })
export const noPlanMember = blocked({ state: 'no-plan', lapsed: false, canManageBilling: false })
export const outOfHoursMember = blocked({
  state: 'out-of-hours',
  cause: 'hours',
  canManageBilling: false
})
export const spendCapMember = blocked({
  state: 'out-of-hours',
  cause: 'cap',
  canManageBilling: false
})
export const paymentIssueAdmin = blocked({ state: 'payment-issue', canManageBilling: true })
