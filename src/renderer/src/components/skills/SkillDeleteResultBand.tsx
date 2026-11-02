import { X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import type { SkillDeleteResult } from '../../../../shared/skill-delete-contract'
import { skillDeleteResultLines } from './skill-delete-copy'
import { SKILLS_PAGE_COLUMN } from './skills-page-column'

/** Keep grouped delete failures visible until acted on; a transient toast would lose actionable details. */
export function SkillDeleteResultBand({
  result,
  onDismiss
}: {
  result: SkillDeleteResult
  onDismiss: () => void
}): React.JSX.Element | null {
  const lines = skillDeleteResultLines(result.skills)
  if (lines.length === 0) {
    return null
  }
  return (
    <div className="shrink-0 border-b border-border bg-muted/40">
      <div className={cn(SKILLS_PAGE_COLUMN, 'flex items-start gap-2 py-2')} role="status">
        <ul className="min-w-0 flex-1 space-y-0.5 text-xs text-muted-foreground">
          {lines.map((line) => (
            <li key={line.key} className="truncate">
              {line.label}
            </li>
          ))}
        </ul>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          onClick={onDismiss}
          aria-label={translate('auto.components.skills.SkillDelete.dismissResults', 'Dismiss')}
        >
          <X />
        </Button>
      </div>
    </div>
  )
}
