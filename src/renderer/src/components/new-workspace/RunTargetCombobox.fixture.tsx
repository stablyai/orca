import { defineFixture } from '../../component-fixtures/component-fixture'
import type { ProjectHostSetupOption } from '@/lib/project-host-setup-options'
import RunTargetCombobox from './RunTargetCombobox'

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

function Preview({ vmSelected }: { vmSelected: boolean }): React.JSX.Element {
  return (
    <div className="h-[460px] p-4">
      <RunTargetCombobox
        hostOptions={options}
        hostValue={vmSelected ? 'vm' : 'mac'}
        hostExecutionHostId={vmSelected ? 'runtime:vm-1' : 'local'}
        onHostChange={() => {}}
        recipes={[]}
        recipeValue={null}
        onAddSshHost={() => {}}
        onAddRemoteServer={() => {}}
        onConnectHost={async () => {}}
        onSetLocation={() => {}}
      />
    </div>
  )
}

const open = (frame: HTMLElement): void => {
  frame.querySelector<HTMLInputElement>('[aria-label="Run on"][role="combobox"]')?.focus()
}
export const vmSelectedClosed = defineFixture({ width: 420, render: () => <Preview vmSelected /> })
export const vmSelected = defineFixture({ ...vmSelectedClosed, interact: open })
export const localSelected = defineFixture({
  width: 420,
  render: () => <Preview vmSelected={false} />,
  interact: open
})
