import { Circle, CircleCheck, Filter, GitMerge, ScanSearch, UserCheck, Wrench } from 'lucide-react'
import { Badge } from '../ui/badge'
import { Card } from '../ui/card'
import { useTranslate } from '@/i18n/use-translate'

export type AutomationStageState = {
  id: string
  status: 'idle' | 'active' | 'pass' | 'attention'
}

const STAGE_ICONS: Record<string, typeof Circle> = {
  triage: Filter,
  approval: UserCheck,
  fix: Wrench,
  review: ScanSearch,
  ci: CircleCheck,
  merge: GitMerge
}

export function WorkbenchAutomationBar({
  stages
}: {
  stages: readonly AutomationStageState[]
}): React.JSX.Element {
  const t = useTranslate()
  return (
    <Card className="flex items-center gap-2 overflow-x-auto p-2 scrollbar-sleek">
      {stages.map((stage, index) => {
        const Icon = STAGE_ICONS[stage.id] ?? Circle
        return (
          <div key={stage.id} className="flex shrink-0 items-center gap-2">
            {index > 0 ? <span className="text-muted-foreground">→</span> : null}
            <span className="flex items-center gap-1.5 text-xs">
              <Icon className="size-4 text-muted-foreground" />
              <span>{t(`auto.components.workbench.bar.${stage.id}`, stage.id)}</span>
              <Badge
                variant={stage.status === 'attention' ? 'destructive' : 'secondary'}
                className="rounded-full"
              >
                {t(`auto.components.workbench.bar.status.${stage.status}`, stage.status)}
              </Badge>
            </span>
          </div>
        )
      })}
    </Card>
  )
}
