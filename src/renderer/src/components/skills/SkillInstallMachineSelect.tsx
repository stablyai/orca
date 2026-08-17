import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'

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
    <Select value={props.value} onValueChange={props.onChange}>
      <SelectTrigger className="w-full sm:w-64">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="local">{props.localLabel}</SelectItem>
        {props.environments.map((environment) => (
          <SelectItem key={environment.id} value={environment.id}>
            {environment.name}
          </SelectItem>
        ))}
        {props.sshTargets.map((target) => (
          <SelectItem key={target.id} value={target.id} disabled={!target.connected}>
            {target.label} {target.connected ? props.sshLabel : props.disconnectedLabel}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}
