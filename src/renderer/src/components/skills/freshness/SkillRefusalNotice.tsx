import { toast } from 'sonner'
import { Copy } from 'lucide-react'
import type { BundledSkillRefusalNotice } from '../../../../../shared/skills/bundled/bundled-skill-backup-refusal'
import { useTranslate } from '@/i18n/use-translate'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/class-names'
import { skillRefusalLines } from './skill-backup-refusal-copy'

/**
 * A copy Orca left on another drive instead of backing it up: why, the full host path with a
 * keyboard-reachable Copy path, then what to do next.
 */
export function SkillRefusalNotice({
  notice,
  className
}: {
  notice: BundledSkillRefusalNotice
  className?: string
}): React.JSX.Element {
  const t = useTranslate()
  const lines = skillRefusalLines(notice, t)
  const copyPath = async (): Promise<void> => {
    try {
      await window.api.ui.writeClipboardText(lines.path)
      toast.success(t('auto.components.skills.SkillRow.pathCopied', 'Path copied'))
    } catch {
      // The path stays on screen, so the user can select it or try again.
    }
  }
  return (
    <div
      data-backup-refusal={notice.source}
      className={cn('flex min-w-0 flex-col gap-0.5 text-xs', className)}
    >
      <span className="text-foreground">{lines.reason}</span>
      <div className="flex min-w-0 items-start gap-1.5">
        <span className="min-w-0 flex-1 select-text font-mono text-2xs leading-5 text-foreground [overflow-wrap:anywhere]">
          {lines.path}
        </span>
        <Button
          type="button"
          variant="ghost"
          size="xs"
          className="shrink-0"
          onClick={() => void copyPath()}
        >
          <Copy className="size-3" />
          {t('auto.components.skills.SkillRow.copyPath', 'Copy path')}
        </Button>
      </div>
      <span className="text-muted-foreground">{lines.next}</span>
    </div>
  )
}
