import type { SshTarget } from '../../../../shared/ssh-types'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select'

type SshTargetSelectProps = {
  targets: SshTarget[]
  value: string
  onChange: (targetId: string) => void
  placeholder: string
}

export function SshTargetSelect({
  targets,
  value,
  onChange,
  placeholder
}: SshTargetSelectProps): React.JSX.Element {
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger className="w-full">
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent>
        {targets.map((target) => (
          <SelectItem key={target.id} value={target.id}>
            {target.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}
