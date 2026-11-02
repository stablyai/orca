import { HostCombobox } from '../host-picker/HostCombobox'

export function SkillInstallMachineSelect(props: {
  value: string
  onChange(value: string): void
  localLabel: string
  sshLabel: string
  disconnectedLabel: string
  environments: readonly { id: string; name: string }[]
  sshTargets: readonly { id: string; label: string; connected: boolean }[]
}): React.JSX.Element {
  return (
    <HostCombobox
      value={props.value}
      onChange={props.onChange}
      className="sm:w-64"
      options={[
        { id: 'local', label: props.localLabel },
        ...props.environments.map((environment) => ({
          id: environment.id,
          label: environment.name
        })),
        ...props.sshTargets.map((target) => ({
          id: target.id,
          label: target.label,
          detail: target.connected ? props.sshLabel : props.disconnectedLabel,
          disabled: !target.connected
        }))
      ]}
    />
  )
}
