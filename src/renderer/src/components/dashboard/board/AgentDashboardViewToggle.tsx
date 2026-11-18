import { Columns3, Network } from 'lucide-react'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { useTranslate } from '@/i18n/use-translate'

export type AgentDashboardView = 'board' | 'fleet'

export function AgentDashboardViewToggle({
  view,
  onViewChange
}: {
  view: AgentDashboardView
  onViewChange: (view: AgentDashboardView) => void
}): React.JSX.Element {
  const t = useTranslate()
  return (
    <ToggleGroup
      type="single"
      variant="segmented"
      size="xs"
      spacing={1}
      value={view}
      onValueChange={(value) => {
        if (value === 'board' || value === 'fleet') {
          onViewChange(value)
        }
      }}
      aria-label={t('dashboardPopout.fleet.view.label', 'Dashboard view')}
      className="shrink-0 bg-muted p-0.5"
    >
      <ToggleGroupItem value="board" className="gap-1.5">
        <Columns3 className="size-3" />
        {t('dashboardPopout.fleet.view.board', 'Board')}
      </ToggleGroupItem>
      <ToggleGroupItem value="fleet" className="gap-1.5">
        <Network className="size-3" />
        {t('dashboardPopout.fleet.view.fleet', 'Fleet')}
      </ToggleGroupItem>
    </ToggleGroup>
  )
}
