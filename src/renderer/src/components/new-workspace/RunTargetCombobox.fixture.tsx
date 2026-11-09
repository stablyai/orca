import { defineFixture } from '../../component-fixtures/component-fixture'
import type { ProjectHostSetupOption } from '@/lib/project-host-setup-options'
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
      canSetLocation: true
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
  access
}: {
  vmSelected?: boolean
  recipes?: EphemeralVmRecipeOption[]
  recipeValue?: string | null
  access?: OrcaCloudRunTargetAccess
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
      />
    </div>
  )
}

function input(frame: HTMLElement): HTMLInputElement | null {
  return frame.querySelector<HTMLInputElement>('[aria-label="Run on"][role="combobox"]')
}
const open = (frame: HTMLElement): void => {
  input(frame)?.focus()
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
  render: () => <Preview recipes={withCloud} access={{ state: 'no-plan', lapsed: false }} />,
  interact: open
})
export const orcaCloudOutOfHours = defineFixture({
  width: 420,
  render: () => (
    <Preview recipes={withCloud} access={{ state: 'out-of-hours', canManageBilling: true }} />
  ),
  interact: open
})
export const orcaCloudOutOfHoursMember = defineFixture({
  width: 420,
  render: () => (
    <Preview recipes={withCloud} access={{ state: 'out-of-hours', canManageBilling: false }} />
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
  render: () => <Preview recipes={withCloud} access={{ state: 'no-plan', lapsed: true }} />,
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
  render: () => <Preview recipes={[devboxRecipe]} access={{ state: 'no-plan', lapsed: false }} />,
  interact: open
})
