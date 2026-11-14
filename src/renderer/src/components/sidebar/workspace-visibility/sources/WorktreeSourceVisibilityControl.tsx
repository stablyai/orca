import { Switch } from '@/components/ui/switch'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import type { ExternalWorktreeVisibility } from '../../../../../../shared/repo-types'
import { worktreeVisibilityValueLabel } from './worktree-visibility-source-provenance'
import { useTranslate } from '@/i18n/use-translate'

const VISIBILITY_SEGMENTS: readonly ExternalWorktreeVisibility[] = ['show', 'hide']

export function WorktreeSourceVisibilityControl({
  visibility,
  disabled,
  label,
  switches,
  onToggle
}: {
  visibility: ExternalWorktreeVisibility
  disabled: boolean
  label: string
  switches: boolean
  onToggle: (enabled: boolean) => void
}): React.JSX.Element {
  const t = useTranslate()
  if (switches) {
    return (
      <Switch
        checked={visibility === 'show'}
        disabled={disabled}
        aria-label={label}
        onCheckedChange={onToggle}
      />
    )
  }
  return (
    <ToggleGroup
      type="single"
      variant="outline"
      size="sm"
      value={visibility}
      disabled={disabled}
      aria-label={t(
        'auto.components.sidebar.WorktreeVisibilitySourceList.visibility',
        'Visibility for {{value0}}',
        { value0: label }
      )}
      className="h-7"
      onValueChange={(next) => {
        // Radix clears reselected segments; ignore that non-change.
        if (next === 'show' || next === 'hide') {
          onToggle(next === 'show')
        }
      }}
    >
      {VISIBILITY_SEGMENTS.map((segment) => (
        <ToggleGroupItem
          key={segment}
          value={segment}
          data-visibility={segment}
          className="h-7 min-w-11 px-2 text-[11px] data-[state=on]:bg-foreground/10 data-[state=on]:font-semibold data-[state=on]:text-foreground"
        >
          {worktreeVisibilityValueLabel(segment, t)}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  )
}
