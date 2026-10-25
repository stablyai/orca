import type { SshTarget } from '../../../../shared/ssh-types'
import { HostCombobox } from '../host-picker/HostCombobox'

type SshTargetSelectProps = {
  id?: string
  targets: SshTarget[]
  value: string
  onChange: (targetId: string) => void
  placeholder: string
}

export function SshTargetSelect({
  id,
  targets,
  value,
  onChange,
  placeholder
}: SshTargetSelectProps): React.JSX.Element {
  return (
    <HostCombobox
      id={id}
      value={value}
      onChange={onChange}
      options={targets}
      placeholder={placeholder}
    />
  )
}
