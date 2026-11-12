import { defineFixture } from '../../component-fixtures/component-fixture'
import type { ProjectHostSetupOption } from '@/lib/workspace/creation/project-host-setup-options'
import RunTargetCombobox from './RunTargetCombobox'
import type { EphemeralVmRecipeOption } from './run-target-options'
import type { OrcaCloudRunTargetAccess } from './orca-cloud-run-target-access'

// Shape produced by buildProjectHostSetupOptions with local + ephemeral VM setups and SSH hosts:
// the VM is dropped entirely, SSH hosts become needs-setup rows.
const options: ProjectHostSetupOption[] = [
  {
    id: 'mac',
    kind: 'ready',
    projectId: 'p',
    hostId: 'local',
    repoId: 'mac',
    label: 'Local Mac',
    detail: 'desktop-app',
    path: '/private/tmp/orca-38669/desktop-app'
  },
  ...['devbox', 'gpu-box', 'staging', 'bastion', 'build-01', 'build-02', 'pi'].map(
    (name): ProjectHostSetupOption => ({
      id: `needs-setup:ssh:${name}`,
      kind: 'needs-setup',
      projectId: 'p',
      hostId: `ssh:${name}`,
      label: name,
      detail: 'Project location not set',
      isAvailable: true,
      attention: false,
      canSetLocation: true,
      // A disconnected host shows Connect inside its option (DS-22 nested-interactive check).
      ...(name === 'gpu-box'
        ? { connectAction: { kind: 'ssh' as const, targetId: 'gpu-box' }, attention: true }
        : {})
    })
  )
]

// Mirrors ORCA_CLOUD_RECIPE from main plus one orca.yaml recipe for the submenu.
const orcaCloud: EphemeralVmRecipeOption = {
  id: 'cloud',
  name: 'Orca Cloud',
  description: 'Hosted by Orca. Sleeps when idle and keeps your files.',
  provider: 'orca-cloud',
  create: 'orca-cloud create',
  destroy: 'orca-cloud destroy'
}
const devboxRecipe: EphemeralVmRecipeOption = {
  id: 'devbox',
  name: 'Devbox',
  create: './scripts/devbox-create.sh',
  destroy: './scripts/devbox-destroy.sh'
}
const NO_RECIPES: EphemeralVmRecipeOption[] = []

function Preview({
  vmSelected = false,
  recipes = NO_RECIPES,
  recipeValue = null,
  access,
  composer = false
}: {
  vmSelected?: boolean
  recipes?: EphemeralVmRecipeOption[]
  recipeValue?: string | null
  access?: OrcaCloudRunTargetAccess
  /** The composer's picker: setup and billing come after Create. */
  composer?: boolean
}): React.JSX.Element {
  return (
    <div className="h-[460px] p-4">
      <RunTargetCombobox
        hostOptions={options}
        hostValue={vmSelected ? 'vm' : 'mac'}
        hostExecutionHostId={vmSelected ? 'runtime:vm-1' : 'local'}
        onHostChange={() => {}}
        recipes={recipes}
        recipeValue={recipeValue}
        onAddSshHost={() => {}}
        onAddRemoteServer={() => {}}
        onConnectHost={async () => {}}
        onSetLocation={() => {}}
        orcaCloudAvailability={
          recipes.some((recipe) => recipe.provider === 'orca-cloud') ? 'offered' : 'needs-sign-in'
        }
        {...(access ? { orcaCloudAccess: access } : {})}
        {...(composer ? { onSelectOrcaCloud: () => {} } : {})}
      />
    </div>
  )
}

function input(frame: HTMLElement): HTMLInputElement | null {
  return frame.querySelector<HTMLInputElement>('[aria-label="Run on"][role="combobox"]')
}
const open = (frame: HTMLElement): void => {
  // Focus alone never opens the list (DS-22); a click does.
  input(frame)?.focus()
  input(frame)?.click()
}
/** Opens the list, then drives it with keys so the keyboard-armed submenu row is captured. */
const pressKeys =
  (...keys: string[]) =>
  async (frame: HTMLElement): Promise<void> => {
    const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 30))
    open(frame)
    await settle()
    for (const key of keys) {
      input(frame)?.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }))
      // Each key reads the arm the previous one committed.
      await settle()
    }
    await new Promise((resolve) => setTimeout(resolve, 300))
  }

export const vmSelectedClosed = defineFixture({ width: 420, render: () => <Preview vmSelected /> })
export const vmSelected = defineFixture({ ...vmSelectedClosed, interact: open })
export const localSelected = defineFixture({
  width: 420,
  render: () => <Preview />,
  interact: open
})

const withCloud = [orcaCloud, devboxRecipe]
export const orcaCloudEntitled = defineFixture({
  width: 420,
  render: () => (
    <Preview recipes={withCloud} access={{ state: 'entitled', remainingSeconds: 41 * 3600 }} />
  ),
  interact: open
})
export const orcaCloudNotEntitled = defineFixture({
  width: 420,
  render: () => (
    <Preview
      recipes={withCloud}
      access={{ state: 'no-plan', lapsed: false, canManageBilling: true }}
    />
  ),
  interact: open
})
export const orcaCloudOutOfHours = defineFixture({
  width: 420,
  render: () => (
    <Preview
      recipes={withCloud}
      access={{ state: 'out-of-hours', cause: 'hours', canManageBilling: true }}
    />
  ),
  interact: open
})
export const orcaCloudOutOfHoursMember = defineFixture({
  width: 420,
  render: () => (
    <Preview
      recipes={withCloud}
      access={{ state: 'out-of-hours', cause: 'hours', canManageBilling: false }}
    />
  ),
  interact: open
})
export const orcaCloudPaymentIssue = defineFixture({
  width: 420,
  render: () => (
    <Preview recipes={withCloud} access={{ state: 'payment-issue', canManageBilling: false }} />
  ),
  interact: open
})
export const orcaCloudLapsed = defineFixture({
  width: 420,
  render: () => (
    <Preview
      recipes={withCloud}
      access={{ state: 'no-plan', lapsed: true, canManageBilling: true }}
    />
  ),
  interact: open
})
export const orcaCloudSelectedClosed = defineFixture({
  width: 420,
  render: () => (
    <Preview
      recipes={withCloud}
      recipeValue="cloud"
      access={{ state: 'entitled', remainingSeconds: 7.5 * 3600 }}
    />
  )
})
export const orcaCloudSelected = defineFixture({ ...orcaCloudSelectedClosed, interact: open })
// Local Mac, Orca Cloud, 6 bounded SSH hosts, then Per-Workspace Environment.
export const recipeSubmenuKeyboard = defineFixture({
  width: 720,
  render: () => (
    <Preview recipes={withCloud} access={{ state: 'entitled', remainingSeconds: 41 * 3600 }} />
  ),
  interact: pressKeys(...Array<string>(12).fill('ArrowDown'), 'ArrowUp', 'ArrowRight')
})
export const addHostSubmenuKeyboard = defineFixture({
  width: 720,
  render: () => <Preview />,
  interact: pressKeys(...Array<string>(12).fill('ArrowDown'), 'Enter', 'ArrowDown')
})
// No Orca Cloud recipe from main: the row still appears to sign in, or to upgrade without the capability.
export const orcaCloudSignedOut = defineFixture({
  width: 420,
  render: () => <Preview recipes={[devboxRecipe]} access={{ state: 'signed-out' }} />,
  interact: open
})
export const orcaCloudNoCapability = defineFixture({
  width: 420,
  render: () => (
    <Preview
      recipes={[devboxRecipe]}
      access={{ state: 'no-plan', lapsed: false, canManageBilling: true }}
    />
  ),
  interact: open
})
export const orcaCloudCapReached = defineFixture({
  width: 420,
  render: () => (
    <Preview
      recipes={withCloud}
      access={{ state: 'out-of-hours', cause: 'cap', canManageBilling: true }}
    />
  ),
  interact: open
})
export const orcaCloudPaymentIssueAdmin = defineFixture({
  width: 420,
  render: () => (
    <Preview recipes={withCloud} access={{ state: 'payment-issue', canManageBilling: true }} />
  ),
  interact: open
})
// First billing read still in flight: a skeleton stands in for the hours.
export const orcaCloudLoading = defineFixture({
  width: 420,
  render: () => <Preview recipes={withCloud} access={{ state: 'loading' }} />,
  interact: open
})
// Below ~20rem the specs drop out of the detail line.
export const orcaCloudNarrow = defineFixture({
  width: 300,
  render: () => (
    <Preview recipes={withCloud} access={{ state: 'entitled', remainingSeconds: 41 * 3600 }} />
  ),
  interact: open
})
// Nothing committed yet: the placeholder shows.
export const nothingSelected = defineFixture({
  width: 420,
  render: () => <Preview vmSelected recipes={withCloud} />
})
// Pointer on an unready host: its ghost "Set project location" appears only while armed.
export const needsSetupArmed = defineFixture({
  width: 420,
  render: () => <Preview />,
  interact: pressKeys('ArrowDown', 'ArrowDown')
})
// DS-15: members see who can fix it, not Upgrade, and the row can't be picked.
export const orcaCloudNoPlanMember = defineFixture({
  width: 420,
  render: () => (
    <Preview
      recipes={withCloud}
      access={{ state: 'no-plan', lapsed: false, canManageBilling: false }}
    />
  ),
  interact: open
})
export const orcaCloudCapReachedMember = defineFixture({
  width: 420,
  render: () => (
    <Preview
      recipes={withCloud}
      access={{ state: 'out-of-hours', cause: 'cap', canManageBilling: false }}
    />
  ),
  interact: open
})

/** Arms a needs-setup row so its Set project location action shows, next to a Connect row. */
export const rowActions = defineFixture({
  ...vmSelectedClosed,
  interact: pressKeys('ArrowDown', 'ArrowDown')
})

// JA-21 (Neil): progressive billing. In the composer Orca Cloud is pickable whatever billing says,
// with no plan, hours or payment words; the creating sheet shows any blocker after Create.
function composerWith(access: OrcaCloudRunTargetAccess, width = 420) {
  return defineFixture({
    width,
    render: () => <Preview composer recipes={withCloud} access={access} />,
    interact: open
  })
}
export const composerOwnerOutOfHours = composerWith({
  state: 'out-of-hours',
  cause: 'hours',
  canManageBilling: true
})
export const composerMemberOutOfHours = composerWith({
  state: 'out-of-hours',
  cause: 'hours',
  canManageBilling: false
})
export const composerMemberPaymentIssue = composerWith({
  state: 'payment-issue',
  canManageBilling: false
})
export const composerMemberPlanEnded = composerWith(
  { state: 'no-plan', lapsed: true, canManageBilling: false },
  320
)
