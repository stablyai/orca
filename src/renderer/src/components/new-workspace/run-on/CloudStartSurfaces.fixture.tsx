// Cloud-start surfaces outside the composer (spec v2): the Landing trial card (E2), the empty "Open
// cloud workspace…" list's button (E3), the build sheet's hours chip (A7, O4) and the trial-used-up notice (T4).
import { defineFixture } from '../../../component-fixtures/component-fixture'
import { LandingCloudCard } from '../../landing/LandingCloudCard'
import { PickerEmptyState } from '../../cloud-workspaces/CloudWorkspacesStates'
import { OrcaCloudHoursChip } from './OrcaCloudHoursChip'
import { OrcaCloudTrialUsedUpNotice } from './OrcaCloudTrialUsedUpNotice'

const setup = (): void => {
  window.api.cloudWorkspaces = { ...window.api.cloudWorkspaces, available: async () => true }
}

/** E2: Landing's first-run card, carrying the trial offer. */
export const e2LandingTrialCard = defineFixture({
  width: 520,
  setup,
  render: () => (
    <div className="p-4">
      <LandingCloudCard
        cloudWorkspacesPresent={false}
        accessOverride={{
          state: 'no-plan',
          lapsed: false,
          canManageBilling: true,
          trialOfferSeconds: 7200
        }}
      />
    </div>
  )
})
/** E3: "Open cloud workspace…" with none at all, with a real button. */
export const e3CloudHomeEmpty = defineFixture({
  width: 560,
  setup,
  render: () => <PickerEmptyState reason={{ kind: 'none' }} onCreate={() => {}} />
})
/** A7: the build sheet header chip while a trial start spins up. */
export const a7BuildSheetChip = defineFixture({
  width: 520,
  setup,
  render: () => (
    <div className="flex items-center gap-2 p-4">
      <span className="text-sm font-medium text-foreground">Starting your cloud workspace</span>
      <OrcaCloudHoursChip
        enabled
        accessOverride={{ state: 'entitled', remainingSeconds: 7200, trial: true }}
      />
    </div>
  )
})
/** T4: the trial runs out while a workspace is running (owner). */
export const t4RunningOwner = defineFixture({
  width: 560,
  setup,
  render: () => (
    <div className="p-4">
      <OrcaCloudTrialUsedUpNotice canManageBilling />
    </div>
  )
})
/** T4: member variant, with the in-app request. */
export const t4RunningMember = defineFixture({
  width: 560,
  setup,
  render: () => (
    <div className="p-4">
      <OrcaCloudTrialUsedUpNotice
        canManageBilling={false}
        teamName="acme"
        onAskForPlan={() => {}}
      />
    </div>
  )
})
