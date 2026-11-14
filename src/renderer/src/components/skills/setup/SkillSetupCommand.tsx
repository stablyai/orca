import { Copy } from 'lucide-react'
import { Button } from '../../ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '../../ui/tooltip'
import { useTranslate } from '@/i18n/use-translate'

export function SkillSetupCommand({
  command,
  onCopy
}: {
  command: string
  onCopy: () => Promise<void>
}): React.JSX.Element {
  const t = useTranslate()
  return (
    <div className="flex min-w-0 max-w-full items-center gap-2 overflow-hidden rounded-md border border-border bg-muted/35 px-3 py-2">
      <code className="scrollbar-sleek min-w-0 flex-1 overflow-x-auto whitespace-nowrap font-mono text-xs text-muted-foreground">
        {command}
      </code>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            className="shrink-0"
            aria-label={t(
              'auto.components.settings.AgentSkillSetupPanel.copyCommandAria',
              'Copy command'
            )}
            onClick={() => void onCopy()}
          >
            <Copy className="size-4" />
          </Button>
        </TooltipTrigger>
        <TooltipContent side="top" sideOffset={4}>
          {t('auto.components.settings.AgentSkillSetupPanel.ed197f59a2', 'Copy command')}
        </TooltipContent>
      </Tooltip>
    </div>
  )
}
