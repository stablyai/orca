import { HostCombobox } from '../../host-picker/HostCombobox'

export function SkillInstallMachineSelect(props: {
  value: string
  onChange(value: string): void
  localLabel: string
  environments: readonly { id: string; name: string }[]
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
        }))
      ]}
    />
  )
}
