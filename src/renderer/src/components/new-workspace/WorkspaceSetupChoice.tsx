import { Button } from '@/components/ui/button'

export function WorkspaceSetupChoice({
  decision,
  onChange,
  disabled = false,
  runLabel,
  skipLabel
}: {
  decision: 'run' | 'skip' | null
  onChange: (decision: 'run' | 'skip') => void
  disabled?: boolean
  runLabel: string
  skipLabel: string
}): React.JSX.Element {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button
        type="button"
        disabled={disabled}
        onClick={() => onChange('run')}
        variant={decision === 'run' ? 'default' : 'outline'}
        size="sm"
      >
        {runLabel}
      </Button>
      <Button
        type="button"
        disabled={disabled}
        onClick={() => onChange('skip')}
        variant={decision === 'skip' ? 'secondary' : 'outline'}
        size="sm"
      >
        {skipLabel}
      </Button>
    </div>
  )
}
